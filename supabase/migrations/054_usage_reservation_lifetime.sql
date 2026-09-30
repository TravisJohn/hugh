-- 054: Give each token reservation its own expiry.
--
-- Migration 049 kept all reservations in one counter and expired the entire
-- total from reserve_window_start. A request arriving just before that shared
-- boundary could lose its claim while still running. This migration retains the
-- counter as the serialization lock and stores one expiry per admitted request.
-- Apply before deploying any code that depends on this behavior.
BEGIN;

-- Wait for counter writers before copying the old aggregate, and hold new
-- writers until the replacement function and backfill commit together.
LOCK TABLE usage_counters IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE usage_reservations (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      UUID        NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  tokens       BIGINT      NOT NULL CHECK (tokens > 0),
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (user_id, period_start)
    REFERENCES usage_counters (user_id, period_start) ON DELETE CASCADE
);

CREATE INDEX usage_reservations_active_idx
  ON usage_reservations (user_id, period_start, expires_at);

ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
-- Only the server's service role may inspect or change reservations.
REVOKE ALL ON TABLE usage_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE usage_reservations TO service_role;
GRANT USAGE, SELECT ON SEQUENCE usage_reservations_id_seq TO service_role;

-- Existing aggregate reservations cannot be separated by arrival time. Keep
-- their full amount for another 150 seconds during cutover, rather than
-- silently freeing budget that might still cover a running request.
INSERT INTO usage_reservations (user_id, period_start, tokens, expires_at)
SELECT user_id, period_start, reserved_tokens, NOW() + INTERVAL '150 seconds'
  FROM usage_counters
 WHERE reserved_tokens > 0;

CREATE OR REPLACE FUNCTION reserve_usage(
  p_user_id       UUID,
  p_period_start  TIMESTAMPTZ,
  p_estimate      BIGINT,
  p_token_limit   BIGINT,
  p_max_requests  INTEGER,
  p_rate_window_s INTEGER,
  p_reserve_ttl_s INTEGER,
  p_now           TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (granted BOOLEAN, reason TEXT, tokens_after BIGINT, retry_after INTEGER)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_row        usage_counters%ROWTYPE;
  v_seed       BIGINT;
  v_reserved   BIGINT;
  v_rate_start TIMESTAMPTZ;
  v_rate_count INTEGER;
  v_window_end TIMESTAMPTZ;
BEGIN
  IF p_estimate IS NULL OR p_estimate < 0
     OR p_reserve_ttl_s IS NULL OR p_reserve_ttl_s <= 0
     OR p_max_requests IS NULL OR p_max_requests <= 0
     OR p_rate_window_s IS NULL OR p_rate_window_s <= 0
     OR p_now IS NULL THEN
    RAISE EXCEPTION 'Invalid usage reservation';
  END IF;

  -- Preserve migration 049's seeding and one-row admission lock.
  SELECT COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0)
    INTO v_seed
    FROM usage_logs
   WHERE user_id = p_user_id
     AND created_at >= p_period_start;

  INSERT INTO usage_counters (
    user_id, period_start, tokens_spent, reserved_tokens, reserve_window_start,
    rate_window_start, rate_count
  )
  VALUES (p_user_id, p_period_start, v_seed, 0, p_now, p_now, 0)
  ON CONFLICT (user_id, period_start) DO NOTHING;

  SELECT * INTO v_row
    FROM usage_counters
   WHERE user_id = p_user_id AND period_start = p_period_start
     FOR UPDATE;

  -- All writers to this table pass through this counter lock. Expire only
  -- claims whose own TTL has passed, then sum the still-active claims.
  DELETE FROM usage_reservations
   WHERE user_id = p_user_id
     AND period_start = p_period_start
     AND expires_at <= p_now;

  SELECT COALESCE(SUM(tokens), 0)
    INTO v_reserved
    FROM usage_reservations
   WHERE user_id = p_user_id
     AND period_start = p_period_start
     AND expires_at > p_now;

  -- Keep migration 049's fixed-window rate limit and refusal semantics.
  v_rate_start := v_row.rate_window_start;
  v_rate_count := v_row.rate_count;
  v_window_end := v_rate_start + make_interval(secs => p_rate_window_s);
  IF p_now >= v_window_end THEN
    v_rate_start := p_now;
    v_rate_count := 0;
    v_window_end := p_now + make_interval(secs => p_rate_window_s);
  END IF;

  IF v_rate_count >= p_max_requests THEN
    UPDATE usage_counters
       SET reserved_tokens   = v_reserved,
           rate_window_start = v_rate_start,
           rate_count        = v_rate_count + 1,
           updated_at        = p_now
     WHERE user_id = p_user_id AND period_start = p_period_start;

    RETURN QUERY SELECT
      FALSE, 'rate_limited'::TEXT, v_row.tokens_spent,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_window_end - p_now)))::INTEGER);
    RETURN;
  END IF;

  IF p_token_limit IS NOT NULL
     AND v_row.tokens_spent + v_reserved + p_estimate > p_token_limit THEN
    UPDATE usage_counters
       SET reserved_tokens   = v_reserved,
           rate_window_start = v_rate_start,
           rate_count        = v_rate_count + 1,
           updated_at        = p_now
     WHERE user_id = p_user_id AND period_start = p_period_start;

    RETURN QUERY SELECT FALSE, 'limit_reached'::TEXT, v_row.tokens_spent, NULL::INTEGER;
    RETURN;
  END IF;

  IF p_estimate > 0 THEN
    INSERT INTO usage_reservations (user_id, period_start, tokens, expires_at)
    VALUES (
      p_user_id, p_period_start, p_estimate,
      p_now + make_interval(secs => p_reserve_ttl_s)
    );
  END IF;

  UPDATE usage_counters
     SET reserved_tokens      = v_reserved + p_estimate,
         reserve_window_start = p_now, -- retained for old readers; no longer drives expiry
         rate_window_start    = v_rate_start,
         rate_count           = v_rate_count + 1,
         updated_at           = p_now
   WHERE user_id = p_user_id AND period_start = p_period_start;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_row.tokens_spent, NULL::INTEGER;
END;
$fn$;

COMMIT;
