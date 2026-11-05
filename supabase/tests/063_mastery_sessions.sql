-- DESTRUCTIVE FIXTURE SETUP: run ONLY in an empty disposable PostgreSQL database
-- named hugh_063_mastery_sessions_test. Both tenants use synthetic UUIDs. No
-- production connection is needed or permitted.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_063_mastery_sessions_test' THEN
    RAISE EXCEPTION 'This fixture requires the disposable hugh_063_mastery_sessions_test database';
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
-- Supabase's default: every role gets every table. This is what 063 refuses.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- CI's Postgres has no pg_cron. This stand-in records what 063 schedules, with
-- the same upsert-by-name behaviour, so the job's SQL can be run for real below.
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobname text PRIMARY KEY, schedule text NOT NULL, command text NOT NULL);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
  LANGUAGE sql AS $$
    INSERT INTO cron.job VALUES (job_name, schedule, command)
    ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command;
    SELECT 1::bigint;
  $$;

-- The real migrations that build milestones, so the foreign keys point at the
-- true table rather than a hand-made copy.
\ir ../migrations/005_tracker.sql
\ir ../migrations/011_milestone_review.sql

INSERT INTO auth.users VALUES
 ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
INSERT INTO tracks (id, user_id, title, topic_description)
 SELECT id, id, 'Synthetic track', 'Synthetic' FROM auth.users;
INSERT INTO milestones (id, track_id, title, summary)
 SELECT id, id, 'Synthetic card', 'Synthetic' FROM auth.users;

\ir ../migrations/063_mastery_sessions.sql
-- Re-running is harmless: every statement is IF NOT EXISTS, a grant, or an upsert.
\ir ../migrations/063_mastery_sessions.sql

CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;

-- RLS is on, there are no learner policies, and learners hold no privilege.
SELECT pg_temp.assert_true(relrowsecurity, 'mastery_sessions has RLS enabled')
  FROM pg_class WHERE oid = 'public.mastery_sessions'::regclass;
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'mastery_sessions'),
  'no policy exposes a session to anyone');
SELECT pg_temp.assert_true(NOT has_table_privilege(r, 'public.mastery_sessions', p), r || ' has no ' || p)
  FROM unnest(ARRAY['authenticated', 'anon']) AS r,
       unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p;
SELECT pg_temp.assert_true(has_table_privilege('service_role', 'public.mastery_sessions', p), 'service_role keeps ' || p)
  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p;

-- The server opens a session and holds its ticks.
SET ROLE service_role;
INSERT INTO mastery_sessions (id, user_id, milestone_id, topic_refs) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111111', ARRAY['vif:1', 'vif:2']);
UPDATE mastery_sessions SET covered = ARRAY['vif:1'], turns = 1
  WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $$ BEGIN
  BEGIN
    INSERT INTO mastery_sessions (user_id, milestone_id, topic_refs)
      VALUES ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '{}');
    RAISE EXCEPTION 'FAIL: a session with no topics was stored';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: a session needs at least one topic'; END;
END $$;
RESET ROLE;

-- The learner whose session it is still cannot read it, give themselves a tick, or forge one.
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$ BEGIN
  BEGIN
    PERFORM covered FROM mastery_sessions WHERE user_id = auth.uid();
    RAISE EXCEPTION 'FAIL: learner read their own session';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: a session is unreadable from a learner session'; END;
  BEGIN
    UPDATE mastery_sessions SET covered = topic_refs;
    RAISE EXCEPTION 'FAIL: learner ticked their own topics';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: a learner cannot tick their own topics'; END;
  BEGIN
    INSERT INTO mastery_sessions (user_id, milestone_id, topic_refs, covered)
      VALUES (auth.uid(), auth.uid(), ARRAY['vif:1'], ARRAY['vif:1']);
    RAISE EXCEPTION 'FAIL: learner planted a finished session';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: a learner cannot plant a session'; END;
  BEGIN
    DELETE FROM mastery_sessions;
    RAISE EXCEPTION 'FAIL: learner deleted a session';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: a learner cannot delete a session'; END;
END $$;
RESET ROLE;

-- The retention job deletes what is old and only that, run from the SQL it scheduled.
INSERT INTO mastery_sessions (id, user_id, milestone_id, topic_refs, created_at) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222',
   '22222222-2222-4222-8222-222222222222', ARRAY['vif:1'], now() - interval '8 days');
SELECT pg_temp.assert_true(count(*) = 1, 'the retention job is scheduled')
  FROM cron.job WHERE jobname = 'retention-mastery-sessions';
DO $$ DECLARE job text; BEGIN
  SELECT command INTO job FROM cron.job WHERE jobname = 'retention-mastery-sessions';
  EXECUTE job;
END $$;
SELECT pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM mastery_sessions WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 'an old session expires');
SELECT pg_temp.assert_true(EXISTS (SELECT 1 FROM mastery_sessions WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'a recent session stays');

-- Sessions leave with the card and with the account.
DELETE FROM milestones WHERE id = '11111111-1111-4111-8111-111111111111';
SELECT pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM mastery_sessions WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'a session is deleted with its card');
INSERT INTO mastery_sessions (id, user_id, milestone_id, topic_refs) VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-2222-4222-8222-222222222222',
   '22222222-2222-4222-8222-222222222222', ARRAY['vif:1']);
DELETE FROM auth.users WHERE id = '22222222-2222-4222-8222-222222222222';
SELECT pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM mastery_sessions WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'), 'a session leaves with the account');
