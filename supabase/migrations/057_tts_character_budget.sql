-- S8: atomically precharge a monthly ElevenLabs character allowance.
-- A precharge is retained even if the provider fails: the provider may have
-- billed before a stream error, and a refund would reopen that spend.
-- Apply before deploying code that calls reserve_tts. Forward-only migration.
BEGIN;

CREATE TABLE tts_counters (
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_start   TIMESTAMPTZ NOT NULL,
  chars_admitted BIGINT      NOT NULL DEFAULT 0 CHECK (chars_admitted >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, period_start)
);

ALTER TABLE tts_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE tts_counters FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE tts_counters TO service_role;

CREATE FUNCTION reserve_tts(
  p_user_id      UUID,
  p_period_start TIMESTAMPTZ,
  p_chars        BIGINT,
  p_char_limit   BIGINT
)
RETURNS TABLE (granted BOOLEAN, chars_after BIGINT)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_row  tts_counters%ROWTYPE;
  v_seed BIGINT;
BEGIN
  IF p_user_id IS NULL OR p_period_start IS NULL OR p_chars IS NULL
     OR p_chars <= 0 OR p_char_limit IS NULL OR p_char_limit <= 0 THEN
    RAISE EXCEPTION 'Invalid TTS reservation';
  END IF;

  SELECT * INTO v_row FROM tts_counters
   WHERE user_id = p_user_id AND period_start = p_period_start
   FOR UPDATE;

  IF NOT FOUND THEN
    -- First touch of a period includes earlier TTS rows. A concurrent creator
    -- may win the INSERT; the following lock always reads the winning counter.
    SELECT COALESCE(SUM(GREATEST(tts_chars, 0)), 0) INTO v_seed
      FROM usage_logs
     WHERE user_id = p_user_id AND created_at >= p_period_start;

    INSERT INTO tts_counters (user_id, period_start, chars_admitted)
    VALUES (p_user_id, p_period_start, v_seed)
    ON CONFLICT (user_id, period_start) DO NOTHING;

    SELECT * INTO v_row FROM tts_counters
     WHERE user_id = p_user_id AND period_start = p_period_start
     FOR UPDATE;
  END IF;

  IF v_row.chars_admitted + p_chars > p_char_limit THEN
    RETURN QUERY SELECT FALSE, v_row.chars_admitted;
    RETURN;
  END IF;

  UPDATE tts_counters
     SET chars_admitted = chars_admitted + p_chars, updated_at = NOW()
   WHERE user_id = p_user_id AND period_start = p_period_start;

  RETURN QUERY SELECT TRUE, v_row.chars_admitted + p_chars;
END;
$fn$;

REVOKE ALL ON FUNCTION reserve_tts(UUID, TIMESTAMPTZ, BIGINT, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_tts(UUID, TIMESTAMPTZ, BIGINT, BIGINT)
  TO service_role;

COMMIT;
