-- Disposable setup for S8. Run only in hugh_s8_security_test.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_s8_security_test' THEN
    RAISE EXCEPTION 'This fixture requires hugh_s8_security_test';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE usage_logs (user_id uuid, created_at timestamptz, tts_chars integer);
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT ON usage_logs TO service_role;
INSERT INTO auth.users VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');
INSERT INTO usage_logs VALUES
  ('11111111-1111-4111-8111-111111111111', '2026-09-10', 18000),
  ('22222222-2222-4222-8222-222222222222', '2026-09-10', 18000);

\ir ../migrations/057_tts_character_budget.sql

DO $$ BEGIN
  IF has_function_privilege('authenticated', 'reserve_tts(uuid,timestamptz,bigint,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated clients can call reserve_tts';
  END IF;
  RAISE NOTICE 'PASS reserve_tts is server-only';
END $$;

SET ROLE service_role;
DO $$
DECLARE decision record;
BEGIN
  SELECT * INTO decision FROM reserve_tts(
    '11111111-1111-4111-8111-111111111111', '2026-09-01', 2000, 20000);
  IF decision.granted IS DISTINCT FROM true OR decision.chars_after <> 20000 THEN
    RAISE EXCEPTION 'Prior usage was not seeded into the character cap';
  END IF;
  SELECT * INTO decision FROM reserve_tts(
    '11111111-1111-4111-8111-111111111111', '2026-09-01', 1, 20000);
  IF decision.granted IS DISTINCT FROM false OR decision.chars_after <> 20000 THEN
    RAISE EXCEPTION 'The exact monthly limit was exceeded';
  END IF;
  IF (SELECT chars_admitted FROM tts_counters
      WHERE user_id = '11111111-1111-4111-8111-111111111111'
        AND period_start = '2026-09-01') <> 20000 THEN
    RAISE EXCEPTION 'A refused request changed the character counter';
  END IF;
  RAISE NOTICE 'PASS prior usage, exact boundary and refusal';

  SELECT * INTO decision FROM reserve_tts(
    '11111111-1111-4111-8111-111111111111', '2026-10-01', 2000, 20000);
  IF decision.granted IS DISTINCT FROM true OR decision.chars_after <> 2000 THEN
    RAISE EXCEPTION 'The new monthly period did not reset';
  END IF;
  RAISE NOTICE 'PASS new period starts a fresh allowance';
END $$;
RESET ROLE;

CREATE TABLE reservation_results (granted boolean NOT NULL);
