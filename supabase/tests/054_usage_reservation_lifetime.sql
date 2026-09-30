-- Disposable PostgreSQL fixture for migration 054. No production credentials.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_s4_security_test' THEN
    RAISE EXCEPTION 'Requires disposable hugh_s4_security_test database';
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

INSERT INTO auth.users VALUES ('44444444-4444-4444-8444-444444444444');
-- A nonzero 049 reservation exists during migration.
SELECT granted FROM reserve_usage(
  '44444444-4444-4444-8444-444444444444', '2099-01-01',
  6000, 10000, 100, 60, 150
);
\ir ../migrations/054_usage_reservation_lifetime.sql

CREATE FUNCTION pg_temp.assert_true(ok BOOLEAN, label TEXT)
RETURNS VOID LANGUAGE plpgsql AS $fn$
BEGIN
  IF ok IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END;
$fn$;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 AND min(tokens) = 6000 AND min(expires_at) > NOW()
     FROM usage_reservations),
  'legacy aggregate remains reserved during migration');
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated', 'usage_reservations', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'usage_reservations', 'INSERT')
  AND has_table_privilege('service_role', 'usage_reservations', 'SELECT'),
  'reservation rows are server-only');

-- The production caller uses service_role, not the migration owner. Supply
-- the pre-existing 049 grants in this minimal fixture and execute the new RPC.
GRANT SELECT ON usage_logs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_counters TO service_role;
SET ROLE service_role;
DO $service$
DECLARE v_result RECORD;
BEGIN
  SELECT * INTO v_result FROM reserve_usage(
    '44444444-4444-4444-8444-444444444444', '2099-01-01',
    100, 10000, 100, 60, 150
  );
  IF NOT v_result.granted THEN
    RAISE EXCEPTION 'service_role could not acquire an S4 reservation';
  END IF;
END;
$service$;
RESET ROLE;
-- Clearing the synthetic counter also clears its migrated reservation.
DELETE FROM usage_counters;
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM usage_reservations),
  'reservation rows cascade with the counter');

DO $test$
DECLARE
  v_user UUID := '44444444-4444-4444-8444-444444444444';
  v_period TIMESTAMPTZ := '2099-01-01';
  v_base TIMESTAMPTZ := date_trunc('second', NOW()) + INTERVAL '1 day';
  v_result RECORD;
BEGIN
  -- The first zero-cost request starts the counter but owns no token claim.
  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 0, 6000, 100, 60, 150, v_base);
  PERFORM pg_temp.assert_true(v_result.granted, 'zero-cost request admitted');
  PERFORM pg_temp.assert_true(
    (SELECT count(*) = 0 FROM usage_reservations),
    'zero-cost request creates no token claim');

  -- Regression: the shared 049 window started at t=0 and would discard the
  -- t=149 claim at t=150. Its own expiry is t=299.
  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 6000, 6000, 100, 60, 150,
    v_base + INTERVAL '149 seconds');
  PERFORM pg_temp.assert_true(v_result.granted, 'late-window claim admitted');

  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 6000, 6000, 100, 60, 150,
    v_base + INTERVAL '150 seconds');
  PERFORM pg_temp.assert_true(
    NOT v_result.granted AND v_result.reason = 'limit_reached',
    'claim remains counted across former shared boundary');

  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 6000, 6000, 100, 60, 150,
    v_base + INTERVAL '298 seconds');
  PERFORM pg_temp.assert_true(
    NOT v_result.granted AND v_result.reason = 'limit_reached',
    'claim remains counted just before its own expiry');

  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 6000, 6000, 100, 60, 150,
    v_base + INTERVAL '299 seconds');
  PERFORM pg_temp.assert_true(v_result.granted, 'claim expires at its own TTL');
  PERFORM pg_temp.assert_true(
    (SELECT count(*) = 1 AND min(tokens) = 6000
       FROM usage_reservations),
    'only the new active claim remains');
  PERFORM pg_temp.assert_true(
    (SELECT reserved_tokens = 6000 FROM usage_counters),
    'cached reserved total matches active claims');

  PERFORM record_usage(v_user, v_period, 1000);
  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 5000, 6000, 100, 60, 150,
    v_base + INTERVAL '300 seconds');
  PERFORM pg_temp.assert_true(
    NOT v_result.granted AND v_result.reason = 'limit_reached',
    'spent plus active claim still enforces the cap');

  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 5000, 6000, 100, 60, 150,
    v_base + INTERVAL '449 seconds');
  PERFORM pg_temp.assert_true(
    v_result.granted, 'new request admitted after its predecessor expires');
  PERFORM pg_temp.assert_true(
    (SELECT tokens_spent = 1000 AND reserved_tokens = 5000
       FROM usage_counters),
    'recorded spend and active claim remain distinct');
END;
$test$;

DELETE FROM usage_counters;
DO $test$
DECLARE
  v_user UUID := '44444444-4444-4444-8444-444444444444';
  v_period TIMESTAMPTZ := '2099-01-01';
  v_base TIMESTAMPTZ := date_trunc('second', NOW()) + INTERVAL '1 day';
  v_result RECORD;
BEGIN
  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 0, NULL, 1, 60, 150, v_base);
  PERFORM pg_temp.assert_true(v_result.granted, 'first rate slot admitted');
  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 0, NULL, 1, 60, 150, v_base);
  PERFORM pg_temp.assert_true(
    NOT v_result.granted AND v_result.reason = 'rate_limited'
    AND v_result.retry_after > 0,
    'rate-limit refusal and retry timing preserved');
  SELECT * INTO v_result FROM reserve_usage(
    v_user, v_period, 0, NULL, 1, 60, 150,
    v_base + INTERVAL '61 seconds');
  PERFORM pg_temp.assert_true(v_result.granted, 'rate window still rolls');
END;
$test$;
SELECT 'S4 reservation lifetime checks passed' AS result;
