-- DESTRUCTIVE FIXTURE SETUP: run ONLY in an empty disposable PostgreSQL database
-- named hugh_058_results_test. Both tenants use synthetic UUIDs. No production
-- connection is needed or permitted.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_058_results_test' THEN
    RAISE EXCEPTION 'This fixture requires the disposable hugh_058_results_test database';
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
-- Supabase's default: every role gets every table. This is what 058 narrows.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- The real migrations that build milestones, so the test runs against the
-- true table rather than a hand-made copy.
\ir ../migrations/005_tracker.sql
\ir ../migrations/011_milestone_review.sql
\ir ../migrations/012_milestone_mastery.sql
\ir ../migrations/016_milestone_focus.sql
\ir ../migrations/018_priority_rank.sql
\ir ../migrations/020_milestone_summary.sql

INSERT INTO auth.users VALUES
 ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
INSERT INTO tracks (id, user_id, title, topic_description)
 SELECT id, id, 'Synthetic track', 'Synthetic' FROM auth.users;
INSERT INTO milestones (id, track_id, title, summary)
 SELECT id, id, 'Synthetic card', 'Synthetic' FROM auth.users;

-- Simulate a historical column grant on top of the broad table grant.
GRANT UPDATE (mastery_validated) ON milestones TO PUBLIC;
\ir ../migrations/058_milestone_result_columns.sql

CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;

-- The four result columns are closed to learners, for update and insert alike.
SELECT pg_temp.assert_true(NOT has_column_privilege('authenticated', 'milestones', c, 'UPDATE'), c || ' update denied to learners')
  FROM unnest(ARRAY['review_validated', 'mastery_validated', 'mastery_score', 'mastery_feedback']) AS c;
SELECT pg_temp.assert_true(NOT has_column_privilege('authenticated', 'milestones', c, 'INSERT'), c || ' insert denied to learners')
  FROM unnest(ARRAY['review_validated', 'mastery_validated', 'mastery_score', 'mastery_feedback']) AS c;
-- So are the server's own columns, and anonymous callers get nothing.
SELECT pg_temp.assert_true(NOT has_column_privilege('authenticated', 'milestones', c, 'UPDATE'), c || ' update denied to learners')
  FROM unnest(ARRAY['track_id', 'title', 'summary', 'priority_rank', 'priority_reason']) AS c;
SELECT pg_temp.assert_true(NOT has_any_column_privilege('anon', 'milestones', 'UPDATE'), 'anonymous updates denied');
SELECT pg_temp.assert_true(NOT has_any_column_privilege('anon', 'milestones', 'INSERT'), 'anonymous inserts denied');
-- What learners' own routes write still works.
SELECT pg_temp.assert_true(has_column_privilege('authenticated', 'milestones', c, 'UPDATE'), c || ' update still permitted')
  FROM unnest(ARRAY['kanban_column', 'position', 'learning_points', 'coverage', 'summary_doc', 'summary_doc_at']) AS c;
SELECT pg_temp.assert_true(has_column_privilege('authenticated', 'milestones', c, 'INSERT'), c || ' insert still permitted')
  FROM unnest(ARRAY['track_id', 'title', 'summary', 'kanban_column', 'position']) AS c;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$ DECLARE n int; BEGIN
  BEGIN
    UPDATE milestones SET mastery_validated = true WHERE id = auth.uid();
    RAISE EXCEPTION 'FAIL: learner marked own card mastered';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: self-certified mastery refused'; END;
  BEGIN
    UPDATE milestones SET review_validated = true WHERE id = auth.uid();
    RAISE EXCEPTION 'FAIL: learner marked own card reviewed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: self-certified review refused'; END;
  BEGIN
    UPDATE milestones SET mastery_score = 10, mastery_feedback = 'Perfect' WHERE id = auth.uid();
    RAISE EXCEPTION 'FAIL: learner wrote own score';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: self-written score refused'; END;
  BEGIN
    INSERT INTO milestones (track_id, title, summary, mastery_validated)
      VALUES (auth.uid(), 'Pre-mastered', 'Forged', true);
    RAISE EXCEPTION 'FAIL: learner inserted a pre-mastered card';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: pre-mastered card insert refused'; END;

  UPDATE milestones SET kanban_column = 'done', position = 3 WHERE id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: own card move'; END IF;
  RAISE NOTICE 'PASS: moving and reordering own card still works';
  UPDATE milestones SET learning_points = '[]', coverage = '{}', summary_doc = 'Doc', summary_doc_at = now()
    WHERE id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: own focus and summary update'; END IF;
  RAISE NOTICE 'PASS: focus points, coverage and summary doc still save';
  INSERT INTO milestones (track_id, title, summary, kanban_column, position)
    VALUES (auth.uid(), 'From Ask', 'Saved session', 'learn', 0);
  RAISE NOTICE 'PASS: a card saved from Ask still inserts';
  UPDATE milestones SET kanban_column = 'learn' WHERE id = '22222222-2222-4222-8222-222222222222';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: other tenant card moved'; END IF;
  RAISE NOTICE 'PASS: other tenant cards remain protected by RLS';
END $$;
RESET ROLE;

SET ROLE service_role;
DO $$ DECLARE n int; BEGIN
  UPDATE milestones SET mastery_validated = true, mastery_score = 8, mastery_feedback = 'Clear and accurate.',
                        review_validated = true
    WHERE id = '11111111-1111-4111-8111-111111111111';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: server result write'; END IF;
  RAISE NOTICE 'PASS: the server still records review and mastery results';
END $$;
RESET ROLE;

SELECT '058 milestone result checks passed' AS result;
