-- Disposable PostgreSQL fixture for migration 062. No production credentials.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_062_usage_release_test' THEN
    RAISE EXCEPTION 'Requires disposable hugh_062_usage_release_test database';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY);
CREATE TABLE usage_logs (
  user_id UUID, created_at TIMESTAMPTZ, tokens_in BIGINT, tokens_out BIGINT
);
\ir ../migrations/049_usage_counters.sql
\ir ../migrations/054_usage_reservation_lifetime.sql
\ir ../migrations/062_usage_release_on_log.sql

INSERT INTO auth.users VALUES ('62626262-6262-4262-8262-626262626262');

CREATE FUNCTION pg_temp.assert_true(ok BOOLEAN, label TEXT)
RETURNS VOID LANGUAGE plpgsql AS $fn$
BEGIN
  IF ok IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END;
$fn$;

-- ── The deploy window, and the bug itself ───────────────────────────────────
-- These are the exact named calls the code makes before this release: no
-- feature on either. They must still resolve once 062 is applied, because the
-- migration goes in before the code deploys. They must also keep the old hold,
-- which reproduces the refusal measured on 2026-10-29: 27,409 of 100,000 really
-- spent, three chats still held, and the next chat refused.
DO $test$
DECLARE
  v_user UUID := '62626262-6262-4262-8262-626262626262';
  v_period TIMESTAMPTZ := '2099-01-01';
  v_result RECORD;
BEGIN
  SELECT * INTO v_result FROM reserve_usage(
    p_user_id => v_user, p_period_start => v_period, p_estimate => 0,
    p_token_limit => 100000, p_max_requests => 100, p_rate_window_s => 60,
    p_reserve_ttl_s => 150);
  PERFORM record_usage(p_user_id => v_user, p_period_start => v_period, p_tokens => 15409);

  FOR i IN 1..3 LOOP
    SELECT * INTO v_result FROM reserve_usage(
      p_user_id => v_user, p_period_start => v_period, p_estimate => 18100,
      p_token_limit => 100000, p_max_requests => 100, p_rate_window_s => 60,
      p_reserve_ttl_s => 150);
    PERFORM pg_temp.assert_true(v_result.granted, 'old call shape: chat admitted');
    PERFORM record_usage(p_user_id => v_user, p_period_start => v_period, p_tokens => 4000);
  END LOOP;

  PERFORM pg_temp.assert_true(
    (SELECT tokens_spent = 27409 FROM usage_counters),
    'old call shape: real spend is recorded');
  PERFORM pg_temp.assert_true(
    (SELECT count(*) = 3 AND sum(tokens) = 54300 FROM usage_reservations),
    'old call shape: a log names nothing, so all three claims stay held');

  SELECT * INTO v_result FROM reserve_usage(
    p_user_id => v_user, p_period_start => v_period, p_estimate => 18400,
    p_token_limit => 100000, p_max_requests => 100, p_rate_window_s => 60,
    p_reserve_ttl_s => 150);
  PERFORM pg_temp.assert_true(
    NOT v_result.granted AND v_result.reason = 'limit_reached',
    'old call shape: the next chat is refused at 27% of the month');
END;
$test$;

-- ── The fix, on the same numbers ────────────────────────────────────────────
DELETE FROM usage_counters;
DO $test$
DECLARE
  v_user UUID := '62626262-6262-4262-8262-626262626262';
  v_period TIMESTAMPTZ := '2099-01-01';
  v_base TIMESTAMPTZ := date_trunc('second', NOW()) + INTERVAL '1 day';
  v_result RECORD;
BEGIN
  PERFORM reserve_usage(v_user, v_period, 0, 100000, 100, 60, 150, v_base, NULL);
  PERFORM record_usage(v_user, v_period, 15409);

  FOR i IN 1..3 LOOP
    SELECT * INTO v_result FROM reserve_usage(
      v_user, v_period, 18100, 100000, 100, 60, 150,
      v_base + make_interval(secs => i * 40), 'learn/chat');
    PERFORM pg_temp.assert_true(v_result.granted, 'chat admitted');
    PERFORM pg_temp.assert_true(
      (SELECT feature = 'learn/chat' FROM usage_reservations),
      'the claim records what it was made for');
    PERFORM record_usage(
      v_user, v_period, 4000, 'learn/chat',
      v_base + make_interval(secs => i * 40 + 5));
    PERFORM pg_temp.assert_true(
      (SELECT count(*) = 0 FROM usage_reservations),
      'logging the call gives its claim back');
  END LOOP;

  PERFORM pg_temp.assert_true(
    (SELECT tokens_spent = 27409 AND reserved_tokens = 0 FROM usage_counters),
    'real spend stays counted, once, and the cached total agrees');

  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 18400, 100000, 100, 60, 150,
    v_base + INTERVAL '130 seconds', 'learn/chat');
  PERFORM pg_temp.assert_true(v_result.granted, 'the same next chat now runs');
END;
$test$;

-- ── A log releases one claim, the oldest, and only its own feature's ────────
DELETE FROM usage_counters;
DO $test$
DECLARE
  v_user UUID := '62626262-6262-4262-8262-626262626262';
  v_period TIMESTAMPTZ := '2099-01-01';
  v_base TIMESTAMPTZ := date_trunc('second', NOW()) + INTERVAL '1 day';
BEGIN
  PERFORM reserve_usage(v_user, v_period, 1000, NULL, 100, 60, 150, v_base, 'learn/chat');
  PERFORM reserve_usage(v_user, v_period, 2000, NULL, 100, 60, 150, v_base + INTERVAL '1 second', 'learn/chat');
  PERFORM reserve_usage(v_user, v_period, 4000, NULL, 100, 60, 150, v_base + INTERVAL '2 seconds', 'code/chat');

  PERFORM record_usage(v_user, v_period, 500, 'notes/coach', v_base + INTERVAL '3 seconds');
  PERFORM pg_temp.assert_true(
    (SELECT count(*) = 3 FROM usage_reservations),
    'a log under another feature releases nothing');
  PERFORM pg_temp.assert_true(
    (SELECT tokens_spent = 500 AND reserved_tokens = 7000 FROM usage_counters),
    'that log still adds its spend');

  PERFORM record_usage(v_user, v_period, 500, 'learn/chat', v_base + INTERVAL '4 seconds');
  PERFORM pg_temp.assert_true(
    (SELECT array_agg(tokens ORDER BY tokens) = ARRAY[2000, 4000]::BIGINT[] FROM usage_reservations),
    'one log releases one claim, the oldest of its feature');
  PERFORM pg_temp.assert_true(
    (SELECT reserved_tokens = 6000 FROM usage_counters),
    'the cached total follows the release');

  PERFORM record_usage(v_user, v_period, 500, 'learn/chat', v_base + INTERVAL '5 seconds');
  PERFORM record_usage(v_user, v_period, 500, 'learn/chat', v_base + INTERVAL '6 seconds');
  PERFORM pg_temp.assert_true(
    (SELECT array_agg(tokens) = ARRAY[4000]::BIGINT[] FROM usage_reservations),
    'a log with no claim left to release touches no other feature''s claim');
  PERFORM pg_temp.assert_true(
    (SELECT tokens_spent = 2000 AND reserved_tokens = 4000 FROM usage_counters),
    'and still adds its spend');
END;
$test$;

-- ── A log with no real spend gives nothing back ─────────────────────────────
DELETE FROM usage_counters;
DO $test$
DECLARE
  v_user UUID := '62626262-6262-4262-8262-626262626262';
  v_period TIMESTAMPTZ := '2099-01-01';
  v_base TIMESTAMPTZ := date_trunc('second', NOW()) + INTERVAL '1 day';
BEGIN
  PERFORM reserve_usage(v_user, v_period, 1000, NULL, 100, 60, 150, v_base, 'learn/chat');
  PERFORM record_usage(v_user, v_period, 0, 'learn/chat', v_base + INTERVAL '1 second');
  PERFORM record_usage(v_user, v_period, -5000, 'learn/chat', v_base + INTERVAL '2 seconds');
  PERFORM pg_temp.assert_true(
    (SELECT count(*) = 1 FROM usage_reservations),
    'a zero or negative log releases no claim');
  PERFORM pg_temp.assert_true(
    (SELECT tokens_spent = 0 FROM usage_counters),
    'and cannot refund spend');
END;
$test$;

-- ── A request that dies never logs, and still heals itself ──────────────────
DELETE FROM usage_counters;
DO $test$
DECLARE
  v_user UUID := '62626262-6262-4262-8262-626262626262';
  v_period TIMESTAMPTZ := '2099-01-01';
  v_base TIMESTAMPTZ := date_trunc('second', NOW()) + INTERVAL '1 day';
  v_result RECORD;
BEGIN
  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 6000, 6000, 100, 60, 150, v_base, 'learn/chat');
  PERFORM pg_temp.assert_true(v_result.granted, 'the doomed request is admitted');

  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 6000, 6000, 100, 60, 150,
    v_base + INTERVAL '149 seconds', 'learn/chat');
  PERFORM pg_temp.assert_true(
    NOT v_result.granted AND v_result.reason = 'limit_reached',
    'an unlogged claim still counts until its expiry');

  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 6000, 6000, 100, 60, 150,
    v_base + INTERVAL '150 seconds', 'learn/chat');
  PERFORM pg_temp.assert_true(v_result.granted, 'and expires on its own, with nothing logged');
END;
$test$;

-- ── A log gives back a live claim, not one already expired ──────────────────
DELETE FROM usage_counters;
DO $test$
DECLARE
  v_user UUID := '62626262-6262-4262-8262-626262626262';
  v_period TIMESTAMPTZ := '2099-01-01';
  v_base TIMESTAMPTZ := date_trunc('second', NOW()) + INTERVAL '1 day';
BEGIN
  PERFORM reserve_usage(v_user, v_period, 1000, NULL, 100, 60, 150, v_base, 'learn/chat');
  PERFORM reserve_usage(v_user, v_period, 2000, NULL, 100, 60, 150, v_base + INTERVAL '100 seconds', 'learn/chat');
  PERFORM record_usage(v_user, v_period, 500, 'learn/chat', v_base + INTERVAL '200 seconds');
  PERFORM pg_temp.assert_true(
    (SELECT array_agg(tokens) = ARRAY[1000]::BIGINT[] FROM usage_reservations),
    'the live claim goes; the expired one waits for the next reservation to clear it');
END;
$test$;

-- ── A claim from before 062 has no feature, so it simply expires ────────────
DELETE FROM usage_counters;
DO $test$
DECLARE
  v_user UUID := '62626262-6262-4262-8262-626262626262';
  v_period TIMESTAMPTZ := '2099-01-01';
  v_base TIMESTAMPTZ := date_trunc('second', NOW()) + INTERVAL '1 day';
BEGIN
  PERFORM reserve_usage(v_user, v_period, 1000, NULL, 100, 60, 150, v_base, NULL);
  PERFORM record_usage(v_user, v_period, 500, 'learn/chat', v_base + INTERVAL '1 second');
  PERFORM pg_temp.assert_true(
    (SELECT count(*) = 1 FROM usage_reservations),
    'a log never matches a claim that names no feature');
END;
$test$;

-- ── The cap itself is unchanged ─────────────────────────────────────────────
DELETE FROM usage_counters;
DO $test$
DECLARE
  v_user UUID := '62626262-6262-4262-8262-626262626262';
  v_period TIMESTAMPTZ := '2099-01-01';
  v_base TIMESTAMPTZ := date_trunc('second', NOW()) + INTERVAL '1 day';
  v_result RECORD;
BEGIN
  PERFORM reserve_usage(v_user, v_period, 96000, 100000, 100, 60, 150, v_base, 'learn/chat');
  PERFORM record_usage(v_user, v_period, 96000, 'learn/chat', v_base + INTERVAL '1 second');

  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 5000, 100000, 100, 60, 150,
    v_base + INTERVAL '2 seconds', 'learn/chat');
  PERFORM pg_temp.assert_true(
    NOT v_result.granted AND v_result.reason = 'limit_reached',
    'released budget is real spend now, so the cap still refuses');

  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 4000, 100000, 100, 60, 150,
    v_base + INTERVAL '3 seconds', 'learn/chat');
  PERFORM pg_temp.assert_true(v_result.granted, 'and still admits what truly fits');
END;
$test$;

-- ── Spend with no counter row is left for the next period's seed ────────────
DELETE FROM usage_counters;
SELECT record_usage('62626262-6262-4262-8262-626262626262', '2099-01-01', 500, 'learn/chat');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM usage_counters),
  'record_usage with no counter row is a no-op, not an error');

-- ── Only the server may call either function ────────────────────────────────
SELECT pg_temp.assert_true(
  NOT has_function_privilege('authenticated', 'record_usage(uuid, timestamptz, bigint, text, timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'record_usage(uuid, timestamptz, bigint, text, timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'reserve_usage(uuid, timestamptz, bigint, bigint, integer, integer, integer, timestamptz, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'reserve_usage(uuid, timestamptz, bigint, bigint, integer, integer, integer, timestamptz, text)', 'EXECUTE'),
  'a learner cannot give their own claim back');
SELECT pg_temp.assert_true(
  (SELECT bool_and(NOT prosecdef) FROM pg_proc WHERE proname IN ('reserve_usage', 'record_usage')),
  'both functions run with the caller''s rights, not the owner''s');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM pg_proc WHERE proname IN ('reserve_usage', 'record_usage')),
  'no old overload is left behind to make a call ambiguous');

-- The production caller is service_role. Supply the pre-existing grants this
-- minimal fixture lacks, then run the whole round trip as that role.
GRANT SELECT ON usage_logs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_counters TO service_role;
SET ROLE service_role;
DO $service$
DECLARE
  v_result RECORD;
BEGIN
  SELECT * INTO v_result FROM reserve_usage(
    p_user_id => '62626262-6262-4262-8262-626262626262', p_period_start => '2099-01-01',
    p_estimate => 1000, p_token_limit => 100000, p_max_requests => 100,
    p_rate_window_s => 60, p_reserve_ttl_s => 150, p_feature => 'learn/chat');
  IF NOT v_result.granted THEN
    RAISE EXCEPTION 'service_role could not reserve';
  END IF;
  PERFORM record_usage(
    p_user_id => '62626262-6262-4262-8262-626262626262', p_period_start => '2099-01-01',
    p_tokens => 400, p_feature => 'learn/chat');
END;
$service$;
RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM usage_reservations),
  'service_role can give a claim back');
DELETE FROM usage_counters;

SELECT 'Migration 062 release-on-log checks passed' AS result;
