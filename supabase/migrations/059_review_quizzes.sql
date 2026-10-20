-- ─────────────────────────────────────────────────────────────────────────────
-- 059 · Review quizzes are graded on the server
--
-- Until now the review quiz was graded in the browser: the quiz route sent the
-- questions WITH their answer key, the page compared the learner's clicks to
-- it, and on a pass the page told the milestone PATCH route to set
-- review_validated. Anyone could skip the quiz and send that pass themselves.
-- 058 closed the column to learners' sessions; this is the other half.
--
-- From now on:
--   review_quizzes       the quiz as generated, answer key included. Written
--                        by tracker/review/quiz, read by the answer and submit
--                        routes. The browser receives the questions only.
--   review_quiz_answers  one locked answer per question. The primary key is
--                        the lock: a second answer to the same question is a
--                        unique violation, so concurrent requests cannot race
--                        a different choice in after the key has been shown.
-- tracker/review/submit grades from these rows and, on a pass, writes
-- milestones.review_validated with the service role.
--
-- Neither table has a learner policy. RLS is on and authenticated/anon hold no
-- privilege at all, so the answer key cannot be read through the REST API —
-- only the service role touches these rows.
--
-- RETENTION: a stored quiz is a system record, not something the learner
-- made; its outcome lives on milestones.review_validated. Quizzes (and, by
-- cascade, their answers) are deleted after 7 days by the pg_cron job below.
-- The window is mirrored in lib/retention.ts and lib/retention.test.ts holds
-- the two equal. pg_cron itself was enabled by 052.
--
-- DEPLOY ORDER: the reverse of 058. Apply this BEFORE the code that reads
-- these tables deploys. It is purely additive — two new tables and one new
-- cron job — so applying it early changes nothing for the code already live.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.review_quizzes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  milestone_id UUID        NOT NULL REFERENCES public.milestones(id) ON DELETE CASCADE,
  -- [{ question, options[4], correctIndex, explanation, source }], as kept by
  -- lib/tracker/quizSource.ts. The answer key is the reason this table exists.
  questions    JSONB       NOT NULL CHECK (jsonb_typeof(questions) = 'array'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.review_quiz_answers (
  quiz_id        UUID        NOT NULL REFERENCES public.review_quizzes(id) ON DELETE CASCADE,
  question_index SMALLINT    NOT NULL CHECK (question_index >= 0),
  -- NULL means the question's timer ran out: an answer, and a wrong one.
  choice         SMALLINT    CHECK (choice BETWEEN 0 AND 3),
  answered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (quiz_id, question_index)
);

CREATE INDEX IF NOT EXISTS review_quizzes_user_id_idx      ON public.review_quizzes (user_id);
CREATE INDEX IF NOT EXISTS review_quizzes_milestone_id_idx ON public.review_quizzes (milestone_id);
CREATE INDEX IF NOT EXISTS review_quizzes_created_at_idx   ON public.review_quizzes (created_at);

ALTER TABLE public.review_quizzes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_quiz_answers ENABLE ROW LEVEL SECURITY;

-- No policies, and no privileges either: RLS alone would already hide every
-- row, but Supabase's default grants would still let a learner's session try.
-- Revoking them makes the refusal a permission error rather than an empty set.
REVOKE ALL ON public.review_quizzes      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.review_quiz_answers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_quizzes      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_quiz_answers TO service_role;

COMMIT;

-- Outside the transaction, like 052: cron.schedule upserts by job name, so
-- re-running this file is harmless.
SELECT cron.schedule(
  'retention-review-quizzes',
  '37 3 * * *',
  $$ DELETE FROM public.review_quizzes
     WHERE created_at < now() - interval '7 days' $$
);

-- To confirm after applying:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'retention-review-quizzes';
--   SELECT has_table_privilege('authenticated', 'public.review_quizzes', 'SELECT');  -- false
