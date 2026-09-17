-- ─────────────────────────────────────────────────────────────────────────────
-- 052 · Retention jobs
--
-- Two scheduled deletions, run inside the database by pg_cron so they need no
-- secret, no external runner, and keep running whether or not anyone deploys.
--
-- The windows are mirrored in lib/retention.ts. lib/retention.test.ts reads
-- THIS FILE and fails the build if an interval here differs from the constant
-- there — change both together.
--
-- What is deliberately NOT expired: anything the learner made (diary, tracks,
-- notes, Monitor documents) and `goal_answers`. Those are kept until the
-- learner deletes them. See lib/retention.ts for why.
--
-- Re-runnable: cron.schedule upserts by job name.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Extracted document text is meant to live only between `extract` and
-- `approve` (migration 031), and approve deletes it. An upload the learner
-- abandons never reaches approve, so without this its text stays forever.
-- The approve route refuses with its own message once the text is gone, rather
-- than building a track from the topic alone.
SELECT cron.schedule(
  'retention-pending-document-extractions',
  '17 3 * * *',
  $$ DELETE FROM public.pending_document_extractions
     WHERE created_at < now() - interval '7 days' $$
);

-- Outcome telemetry (migration 047). Already redacted and capped at write time.
-- /admin/observability reads 30 days back; /admin/features' "All time" health
-- column is labelled with this window so it does not over-claim.
SELECT cron.schedule(
  'retention-operation-events',
  '27 3 * * *',
  $$ DELETE FROM public.operation_events
     WHERE created_at < now() - interval '180 days' $$
);

-- To confirm after applying:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'retention-%';
-- And later, that they ran:
--   SELECT j.jobname, d.status, d.start_time FROM cron.job_run_details d
--   JOIN cron.job j USING (jobid) WHERE j.jobname LIKE 'retention-%'
--   ORDER BY d.start_time DESC LIMIT 10;
