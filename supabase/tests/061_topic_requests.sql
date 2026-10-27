-- DESTRUCTIVE FIXTURE SETUP: run ONLY in an empty disposable PostgreSQL database
-- named hugh_061_topic_requests_test. Every id is a synthetic UUID. No
-- production connection is needed or permitted.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_061_topic_requests_test' THEN
    RAISE EXCEPTION 'This fixture requires the disposable hugh_061_topic_requests_test database';
  END IF;
END $$;

-- Roles are shared by every database in the cluster; CI runs several fixtures.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
-- Supabase's default: every role gets every table. 061 must take that back.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

\ir ../migrations/061_topic_requests.sql
-- Applying it twice must be harmless: migrations are re-run by hand.
\ir ../migrations/061_topic_requests.sql

INSERT INTO auth.users VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');

CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;

-- ── Server-written only: learners and anonymous callers hold nothing ────────
SELECT pg_temp.assert_true(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.topic_requests'::regclass),
  'row level security is on');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM pg_policies WHERE tablename = 'topic_requests'),
  'there is no learner policy to widen by mistake');
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated', 'public.topic_requests', 'SELECT, INSERT, UPDATE, DELETE'),
  'learners hold no privilege on topic requests');
SELECT pg_temp.assert_true(
  NOT has_table_privilege('anon', 'public.topic_requests', 'SELECT, INSERT, UPDATE, DELETE'),
  'anonymous callers hold no privilege on topic requests');

-- ── The server can save a request ───────────────────────────────────────────
SET ROLE service_role;
INSERT INTO topic_requests (user_id, requested_topic) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Causal inference'),
  ('22222222-2222-4222-8222-222222222222', 'Dimensional modelling');
INSERT INTO topic_requests (user_id, requested_topic)
  VALUES ('11111111-1111-4111-8111-111111111111', repeat('x', 120));
RESET ROLE;
SELECT pg_temp.assert_true((SELECT count(*) = 3 FROM topic_requests), 'the server saves a request, up to 120 characters');

-- ── The text's shape is held by the table, not only by the route ────────────
SET ROLE service_role;
DO $$ BEGIN
  BEGIN
    INSERT INTO topic_requests (user_id, requested_topic) VALUES ('11111111-1111-4111-8111-111111111111', '');
    RAISE EXCEPTION 'FAIL: an empty request was saved';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: an empty request is refused'; END;
  BEGIN
    INSERT INTO topic_requests (user_id, requested_topic) VALUES ('11111111-1111-4111-8111-111111111111', '   ');
    RAISE EXCEPTION 'FAIL: a blank request was saved';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: a blank request is refused'; END;
  BEGIN
    INSERT INTO topic_requests (user_id, requested_topic) VALUES ('11111111-1111-4111-8111-111111111111', ' Padded ');
    RAISE EXCEPTION 'FAIL: an untrimmed request was saved';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: a request is stored trimmed or not at all'; END;
  BEGIN
    INSERT INTO topic_requests (user_id, requested_topic) VALUES ('11111111-1111-4111-8111-111111111111', repeat('x', 121));
    RAISE EXCEPTION 'FAIL: a 121-character request was saved';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: a request longer than the box allows is refused'; END;
  BEGIN
    INSERT INTO topic_requests (user_id, requested_topic) VALUES ('33333333-3333-4333-8333-333333333333', 'Orphan');
    RAISE EXCEPTION 'FAIL: a request was saved for an account that does not exist';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: every request belongs to a real account'; END;
END $$;
RESET ROLE;

-- ── A learner's own session cannot read, plant, edit or remove requests ─────
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$ BEGIN
  BEGIN
    PERFORM requested_topic FROM topic_requests WHERE user_id = auth.uid();
    RAISE EXCEPTION 'FAIL: learner read their own requests';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: requests are unreadable from a learner session'; END;
  BEGIN
    INSERT INTO topic_requests (user_id, requested_topic) VALUES (auth.uid(), 'Skipping the daily limit');
    RAISE EXCEPTION 'FAIL: learner saved a request without going through the route';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: a learner cannot skip the route and its daily limit'; END;
  BEGIN
    UPDATE topic_requests SET requested_topic = 'Rewritten';
    RAISE EXCEPTION 'FAIL: learner rewrote a request';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: a learner cannot rewrite a request'; END;
  BEGIN
    DELETE FROM topic_requests;
    RAISE EXCEPTION 'FAIL: learner deleted requests';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: a learner cannot delete requests directly'; END;
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;
SET ROLE anon;
DO $$ BEGIN
  BEGIN
    PERFORM 1 FROM topic_requests;
    RAISE EXCEPTION 'FAIL: anonymous caller read requests';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anonymous callers get nothing'; END;
END $$;
RESET ROLE;

-- ── Deleting an account deletes its requests, and only its requests ─────────
DELETE FROM auth.users WHERE id = '11111111-1111-4111-8111-111111111111';
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM topic_requests WHERE user_id = '11111111-1111-4111-8111-111111111111'),
  'deleting an account removes its requests');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM topic_requests WHERE user_id = '22222222-2222-4222-8222-222222222222'),
  'another learner''s request is untouched');
