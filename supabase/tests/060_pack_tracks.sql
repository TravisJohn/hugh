-- DESTRUCTIVE FIXTURE SETUP: run ONLY in an empty disposable PostgreSQL database
-- named hugh_060_pack_tracks_test. Every id is a synthetic UUID. No production
-- connection is needed or permitted.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_060_pack_tracks_test' THEN
    RAISE EXCEPTION 'This fixture requires the disposable hugh_060_pack_tracks_test database';
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
-- Supabase's default: every role gets every table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
-- 019 adds learning_goals to Supabase's Realtime publication, which a bare
-- PostgreSQL does not have.
CREATE PUBLICATION supabase_realtime;

-- The real migrations, so the test runs against the true tables.
\ir ../migrations/005_tracker.sql
\ir ../migrations/006_learning_goals.sql
\ir ../migrations/011_milestone_review.sql
\ir ../migrations/012_milestone_mastery.sql
\ir ../migrations/016_milestone_focus.sql
\ir ../migrations/018_priority_rank.sql
\ir ../migrations/019_goal_track_status.sql
\ir ../migrations/020_milestone_summary.sql
\ir ../migrations/031_document_goal_source.sql
\ir ../migrations/046_track_build_retry.sql
\ir ../migrations/048_curriculum_provenance.sql
\ir ../migrations/051_goal_region.sql
\ir ../migrations/058_milestone_result_columns.sql

-- A card that exists before 060, to prove the new column backfills safely.
INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO tracks (id, user_id, title, topic_description)
  VALUES ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Synthetic track', 'Synthetic');
INSERT INTO milestones (id, track_id, title, summary)
  VALUES ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Synthetic card', 'Synthetic');

\ir ../migrations/060_pack_tracks.sql
-- Applying it twice must be harmless: migrations are re-run by hand.
\ir ../migrations/060_pack_tracks.sql

CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;

-- Refused-insert check: runs the statement and reports whether a CHECK refused it.
CREATE FUNCTION pg_temp.refused(stmt text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RETURN false;
EXCEPTION WHEN check_violation THEN
  RETURN true;
END $$;

-- ── concept_ids: what grounding will trust, so learners cannot write it ─────
SELECT pg_temp.assert_true(NOT has_column_privilege('authenticated', 'milestones', 'concept_ids', 'UPDATE'), 'learners cannot update concept_ids');
SELECT pg_temp.assert_true(NOT has_column_privilege('authenticated', 'milestones', 'concept_ids', 'INSERT'), 'learners cannot insert concept_ids');
SELECT pg_temp.assert_true(NOT has_column_privilege('anon', 'milestones', 'concept_ids', 'UPDATE'), 'anonymous callers cannot update concept_ids');
SELECT pg_temp.assert_true(
  (SELECT concept_ids = '{}' FROM milestones WHERE id = '11111111-1111-4111-8111-111111111111'),
  'a card built before 060 reads as teaching no pack concepts');
-- 058's learner allowance is untouched: moving a card still works.
SELECT pg_temp.assert_true(has_column_privilege('authenticated', 'milestones', 'kanban_column', 'UPDATE'), 'learners can still move a card');

UPDATE milestones SET concept_ids = ARRAY['linear-regression:least_squares']
  WHERE id = '11111111-1111-4111-8111-111111111111';
SELECT pg_temp.assert_true(
  (SELECT concept_ids = ARRAY['linear-regression:least_squares'] FROM milestones WHERE id = '11111111-1111-4111-8111-111111111111'),
  'the server can record what a card teaches');

-- ── learning_goals: a course goal names its pack and version, nothing else does
INSERT INTO learning_goals (id, user_id, topic, end_date, source_kind, pack_id, pack_version)
  VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
          'Linear regression', '2026-12-01', 'pack', 'linear-regression', '2.2.0');
SELECT pg_temp.assert_true(
  (SELECT source_kind = 'pack' FROM learning_goals WHERE id = '22222222-2222-4222-8222-222222222222'),
  'a course goal is accepted');
SELECT pg_temp.assert_true(pg_temp.refused(
  $$INSERT INTO learning_goals (user_id, topic, end_date, source_kind)
    VALUES ('11111111-1111-4111-8111-111111111111', 'x', '2026-12-01', 'pack')$$),
  'a pack goal must name its pack');
SELECT pg_temp.assert_true(pg_temp.refused(
  $$INSERT INTO learning_goals (user_id, topic, end_date, source_kind, pack_id)
    VALUES ('11111111-1111-4111-8111-111111111111', 'x', '2026-12-01', 'pack', 'linear-regression')$$),
  'a pack goal must record the version it was built from');
SELECT pg_temp.assert_true(pg_temp.refused(
  $$INSERT INTO learning_goals (user_id, topic, end_date, source_kind, pack_id, pack_version)
    VALUES ('11111111-1111-4111-8111-111111111111', 'x', '2026-12-01', 'qa', 'linear-regression', '2.2.0')$$),
  'an open-topic goal cannot claim a pack');
SELECT pg_temp.assert_true(pg_temp.refused(
  $$INSERT INTO learning_goals (user_id, topic, end_date, source_kind)
    VALUES ('11111111-1111-4111-8111-111111111111', 'x', '2026-12-01', 'unknown')$$),
  'an unknown goal source is still refused');
-- Existing goals keep working unchanged.
INSERT INTO learning_goals (user_id, topic, end_date)
  VALUES ('11111111-1111-4111-8111-111111111111', 'An open topic', '2026-12-01');
SELECT pg_temp.assert_true(
  (SELECT source_kind = 'qa' AND pack_id IS NULL FROM learning_goals WHERE topic = 'An open topic'),
  'an open-topic goal is still accepted, defaulting to qa');

-- ── track_generations: a pack build can record its provenance ───────────────
INSERT INTO track_generations (source_kind, model, prompt_version, prompt_fingerprint, input_topic, outcome)
  VALUES ('pack', 'pack', 'linear-regression@2.2.0', 'sha256:synthetic', 'linear-regression', 'ok');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM track_generations WHERE source_kind = 'pack'), 'a pack build records its provenance');
SELECT pg_temp.assert_true(pg_temp.refused(
  $$INSERT INTO track_generations (source_kind, model, prompt_version, prompt_fingerprint, input_topic, outcome)
    VALUES ('unknown', 'x', 'x', 'x', 'x', 'ok')$$),
  'an unknown build source is still refused');
