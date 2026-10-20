-- DESTRUCTIVE FIXTURE SETUP: run ONLY in an empty disposable PostgreSQL database
-- named hugh_059_review_quizzes_test. Both tenants use synthetic UUIDs. No
-- production connection is needed or permitted.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_059_review_quizzes_test' THEN
    RAISE EXCEPTION 'This fixture requires the disposable hugh_059_review_quizzes_test database';
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
-- Supabase's default: every role gets every table. This is what 059 refuses.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- CI's Postgres has no pg_cron. This stand-in records what 059 schedules, with
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

\ir ../migrations/059_review_quizzes.sql
-- Re-running is harmless: every statement is IF NOT EXISTS, a grant, or an upsert.
\ir ../migrations/059_review_quizzes.sql

CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;

-- RLS is on, there are no learner policies, and learners hold no privilege.
SELECT pg_temp.assert_true(relrowsecurity, relname || ' has RLS enabled')
  FROM pg_class WHERE oid IN ('public.review_quizzes'::regclass, 'public.review_quiz_answers'::regclass);
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('review_quizzes', 'review_quiz_answers')),
  'no policy exposes quizzes or answers to anyone');
SELECT pg_temp.assert_true(NOT has_table_privilege(r, t, p), r || ' has no ' || p || ' on ' || t)
  FROM unnest(ARRAY['authenticated', 'anon']) AS r,
       unnest(ARRAY['public.review_quizzes', 'public.review_quiz_answers']) AS t,
       unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p;
SELECT pg_temp.assert_true(has_table_privilege('service_role', t, p), 'service_role keeps ' || p || ' on ' || t)
  FROM unnest(ARRAY['public.review_quizzes', 'public.review_quiz_answers']) AS t,
       unnest(ARRAY['SELECT', 'INSERT', 'DELETE']) AS p;

-- The server stores a quiz and locks answers.
SET ROLE service_role;
INSERT INTO review_quizzes (id, user_id, milestone_id, questions) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111111',
   '[{"question":"Q","options":["a","b","c","d"],"correctIndex":2,"explanation":"E","source":"S"}]');
INSERT INTO review_quiz_answers (quiz_id, question_index, choice)
  VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 1);
DO $$ BEGIN
  BEGIN
    INSERT INTO review_quiz_answers (quiz_id, question_index, choice)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 2);
    RAISE EXCEPTION 'FAIL: a second answer replaced the locked one';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: an answered question cannot be answered again'; END;
  BEGIN
    INSERT INTO review_quiz_answers (quiz_id, question_index, choice)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 4);
    RAISE EXCEPTION 'FAIL: an option that does not exist was stored';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: only options 0-3 can be stored'; END;
  BEGIN
    INSERT INTO review_quizzes (user_id, milestone_id, questions)
      VALUES ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '{}');
    RAISE EXCEPTION 'FAIL: a quiz that is not a list of questions was stored';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: questions must be an array'; END;
END $$;
-- A timed-out question is stored as a NULL choice.
INSERT INTO review_quiz_answers (quiz_id, question_index, choice)
  VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, NULL);
RESET ROLE;

-- The learner whose quiz it is still cannot read the key, or forge a quiz or an answer.
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$ BEGIN
  BEGIN
    PERFORM questions FROM review_quizzes WHERE user_id = auth.uid();
    RAISE EXCEPTION 'FAIL: learner read their own answer key';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: the answer key is unreadable from a learner session'; END;
  BEGIN
    PERFORM choice FROM review_quiz_answers;
    RAISE EXCEPTION 'FAIL: learner read stored answers';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: stored answers are unreadable from a learner session'; END;
  BEGIN
    INSERT INTO review_quizzes (user_id, milestone_id, questions) VALUES (auth.uid(), auth.uid(), '[]');
    RAISE EXCEPTION 'FAIL: learner stored their own quiz';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: a learner cannot plant a quiz'; END;
  BEGIN
    UPDATE review_quiz_answers SET choice = 2;
    RAISE EXCEPTION 'FAIL: learner rewrote a locked answer';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: a learner cannot change a locked answer'; END;
  BEGIN
    DELETE FROM review_quiz_answers;
    RAISE EXCEPTION 'FAIL: learner deleted a locked answer';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: a learner cannot unlock an answer by deleting it'; END;
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
  BEGIN
    PERFORM 1 FROM review_quizzes;
    RAISE EXCEPTION 'FAIL: anonymous caller read quizzes';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anonymous callers get nothing'; END;
END $$;
RESET ROLE;

-- Retention: the job is scheduled once, deletes after exactly 7 days, and the
-- answers go with their quiz.
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM cron.job WHERE jobname = 'retention-review-quizzes') = 1,
  'the retention job is scheduled exactly once, even after a re-run');
SELECT pg_temp.assert_true(
  (SELECT command LIKE '%DELETE FROM public.review_quizzes%' AND command LIKE '%interval ''7 days''%'
     FROM cron.job WHERE jobname = 'retention-review-quizzes'),
  'the retention job deletes quizzes older than 7 days');

INSERT INTO review_quizzes (id, user_id, milestone_id, questions, created_at) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222',
   '22222222-2222-4222-8222-222222222222', '[]', now() - interval '8 days');
INSERT INTO review_quiz_answers (quiz_id, question_index, choice)
  VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 0, 0);
DO $$ BEGIN
  EXECUTE (SELECT command FROM cron.job WHERE jobname = 'retention-review-quizzes');
END $$;
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM review_quizzes WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  'a quiz older than the window is deleted');
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM review_quiz_answers WHERE quiz_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  'its answers are deleted with it');
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM review_quizzes WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'a quiz inside the window is kept');

-- Deleting the card (or the account) takes its quizzes with it.
DELETE FROM milestones WHERE id = '11111111-1111-4111-8111-111111111111';
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM review_quizzes) AND NOT EXISTS (SELECT 1 FROM review_quiz_answers),
  'deleting a card deletes its quizzes and answers');

SELECT '059 review quiz checks passed' AS result;
