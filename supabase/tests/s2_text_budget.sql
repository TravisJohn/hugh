-- Synthetic, disposable database only. Does not connect to Supabase.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_s2_security_test' THEN
    RAISE EXCEPTION 'Requires disposable hugh_s2_security_test database';
  END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE usage_logs (user_id uuid, created_at timestamptz, tokens_in bigint, tokens_out bigint);
\ir ../migrations/049_usage_counters.sql
INSERT INTO auth.users VALUES ('33333333-3333-4333-8333-333333333333');
INSERT INTO usage_logs VALUES ('33333333-3333-4333-8333-333333333333', '2026-09-29', 70000, 0);
CREATE TABLE reservation_results (granted boolean);
