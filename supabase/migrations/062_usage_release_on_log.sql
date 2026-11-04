-- 062: A logged call gives back its reservation.
--
-- The gate sets aside an estimate before each call, and since 054 each admitted
-- request owns one usage_reservations row. Those rows only ever expired, so for
-- 150 seconds after a call's real spend reached tokens_spent, that call counted
-- twice. A course-card chat sets aside about 18,000 tokens and spends about
-- 4,000, so on 2026-10-29 a learner who had really spent 27,409 of 100,000 was
-- refused as "Monthly usage limit reached".
--
-- 049 chose expiry because one gate then billed three features, so a log could
-- not say what to give back. Every billed call now has its own gate under the
-- name it logs, which lib/usageNames.test.ts holds. So a log now removes the
-- oldest live claim of its own feature, in one transaction with adding the
-- spend, and spent + reserved never dips below what was really spent.
--
-- Expiry stays exactly as it was. It is what heals a request that dies before
-- it logs, with nothing having to run in its failure path. Claims made before
-- this migration have no feature, match no log, and expire as they always did.
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT CALLS IT. Both new parameters default
-- to NULL, so the code already running keeps working, and keeps its old hold,
-- until the new code arrives. In the other order the new code's calls find no
-- such function, and every gated request is refused as "unavailable".
BEGIN;

ALTER TABLE usage_reservations ADD COLUMN feature TEXT;

-- CREATE OR REPLACE cannot add a parameter. It would leave the old signature
-- beside the new one, and a named call that fits both is an ambiguous-call error.
DROP FUNCTION reserve_usage(UUID, TIMESTAMPTZ, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ);
DROP FUNCTION record_usage(UUID, TIMESTAMPTZ, BIGINT);

-- Unchanged from 054 except that a claim now records its feature.
CREATE FUNCTION reserve_usage(
  p_user_id       UUID,
  p_period_start  TIMESTAMPTZ,
  p_estimate      BIGINT,
  p_token_limit   BIGINT,
  p_max_requests  INTEGER,
  p_rate_window_s INTEGER,
  p_reserve_ttl_s INTEGER,
  p_now           TIMESTAMPTZ DEFAULT NOW(),
  p_feature       TEXT        DEFAULT NULL
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
    INSERT INTO usage_reservations (user_id, period_start, tokens, expires_at, feature)
    VALUES (
      p_user_id, p_period_start, p_estimate,
      p_now + make_interval(secs => p_reserve_ttl_s),
      p_feature
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

-- Add one call's real spend, and give back the claim that call made.
--
-- `p_feature` NULL only adds the spend: what the code already running does, and
-- what spend the server never saw must do (see `reservationReleasedBy`).
CREATE FUNCTION record_usage(
  p_user_id      UUID,
  p_period_start TIMESTAMPTZ,
  p_tokens       BIGINT,
  p_feature      TEXT        DEFAULT NULL,
  p_now          TIMESTAMPTZ DEFAULT NOW()
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_released BIGINT;
BEGIN
  -- This takes the counter's row lock first, the order reserve_usage locks in,
  -- so the two cannot deadlock over a reservation row.
  UPDATE usage_counters
     SET tokens_spent = tokens_spent + GREATEST(0, p_tokens),
         updated_at   = p_now
   WHERE user_id = p_user_id AND period_start = p_period_start;

  -- No counter row means spend that never passed a gate, so there is no claim
  -- either; reserve_usage picks the spend up when it next seeds the period. A
  -- log with no real spend added nothing, so it may not give anything back.
  IF NOT FOUND OR p_feature IS NULL OR p_tokens <= 0 THEN
    RETURN;
  END IF;

  -- Oldest first: with the same feature in flight twice, the earlier call is the
  -- likelier one to have just finished. Picking the other costs nothing lasting;
  -- what stays held still expires.
  DELETE FROM usage_reservations
   WHERE id = (
     SELECT id
       FROM usage_reservations
      WHERE user_id = p_user_id
        AND period_start = p_period_start
        AND feature = p_feature
        AND expires_at > p_now
      ORDER BY id
      LIMIT 1
   )
  RETURNING tokens INTO v_released;

  IF v_released IS NOT NULL THEN
    UPDATE usage_counters
       SET reserved_tokens = GREATEST(0, reserved_tokens - v_released)
     WHERE user_id = p_user_id AND period_start = p_period_start;
  END IF;
END;
$fn$;

-- A learner who could call record_usage could give their own claim back.
REVOKE ALL ON FUNCTION reserve_usage(UUID, TIMESTAMPTZ, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_usage(UUID, TIMESTAMPTZ, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TEXT)
  TO service_role;
REVOKE ALL ON FUNCTION record_usage(UUID, TIMESTAMPTZ, BIGINT, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_usage(UUID, TIMESTAMPTZ, BIGINT, TEXT, TIMESTAMPTZ)
  TO service_role;

-- The API must see the new signatures before the new code calls them.
NOTIFY pgrst, 'reload schema';

COMMIT;
