-- ─────────────────────────────────────────────────────────────────────────────
-- 063 · Mastery's ticks are held on the server
--
-- A mastery session is now judged by which topics the learner covered, and a
-- tick is what writes the result. So the ticks cannot live in the browser: a
-- learner's session has been barred from writing results since 058, and letting
-- it name its own ticks would be the same hole by another door.
--
-- One row per session, written only by tracker/mastery/session:
--   topic_refs   the card's topics when the session began, so the share of
--                topics covered cannot change under a session already running.
--   covered      topics ticked. The route only ever adds to this.
--   held         wrong beliefs stated and not yet taken back.
--   turns        turns checked, which caps what one session can spend.
--
-- It stores references, never the learner's words. The privacy page says Hugh
-- does not keep a transcript, and that stays true.
--
-- No learner policy and no learner privilege, like 059: RLS is on and
-- authenticated/anon hold nothing, so only the service role touches these rows.
--
-- RETENTION: a system record, not something the learner made; the outcome lives
-- on milestones.mastery_score and mastery_validated. Deleted after 7 days by the
-- pg_cron job below. The window is mirrored in lib/retention.ts and
-- lib/retention.test.ts holds the two equal.
--
-- DEPLOY ORDER: apply this BEFORE the code that reads this table deploys. It is
-- purely additive, so applying it early changes nothing for the code already live.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.mastery_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  milestone_id UUID        NOT NULL REFERENCES public.milestones(id) ON DELETE CASCADE,
  topic_refs   TEXT[]      NOT NULL CHECK (cardinality(topic_refs) > 0),
  covered      TEXT[]      NOT NULL DEFAULT '{}',
  held         TEXT[]      NOT NULL DEFAULT '{}',
  turns        SMALLINT    NOT NULL DEFAULT 0 CHECK (turns >= 0),
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mastery_sessions_user_milestone_idx ON public.mastery_sessions (user_id, milestone_id);
CREATE INDEX IF NOT EXISTS mastery_sessions_milestone_id_idx   ON public.mastery_sessions (milestone_id);
CREATE INDEX IF NOT EXISTS mastery_sessions_created_at_idx     ON public.mastery_sessions (created_at);

ALTER TABLE public.mastery_sessions ENABLE ROW LEVEL SECURITY;

-- No policies, and no privileges either: RLS alone would already hide every
-- row, but Supabase's default grants would still let a learner's session try.
REVOKE ALL ON public.mastery_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mastery_sessions TO service_role;

COMMIT;

-- Outside the transaction, like 052 and 059: cron.schedule upserts by job name,
-- so re-running this file is harmless.
SELECT cron.schedule(
  'retention-mastery-sessions',
  '47 3 * * *',
  $$ DELETE FROM public.mastery_sessions
     WHERE created_at < now() - interval '7 days' $$
);

-- To confirm after applying:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'retention-mastery-sessions';
--   SELECT has_table_privilege('authenticated', 'public.mastery_sessions', 'SELECT');  -- false
