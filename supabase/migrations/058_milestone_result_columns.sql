-- 058: review and mastery results are server-owned.
--
-- Before this, the milestones_owner policy (FOR ALL) together with Supabase's
-- default table grants let a signed-in learner UPDATE their own milestones
-- straight through the REST API, setting review_validated, mastery_validated,
-- mastery_score and mastery_feedback without passing anything. Checked on
-- production 2026-10-17. From now on only the server writes those four columns
-- (service role), after it has graded the learner itself.
--
-- A learner keeps exactly the columns their own routes write through their
-- session, and nothing else:
--   UPDATE kanban_column                 tracker/milestones/[id] (moving a card)
--   UPDATE position                      tracker/tracks/[trackId]/reorder
--   UPDATE learning_points, coverage     tracker/milestones/[id]/coverage
--   UPDATE summary_doc, summary_doc_at   tracker/milestones/[id]/summary
--   INSERT track_id, title, summary,     learn/save-summary (a card from an
--          kanban_column, position       Ask session)
-- Track generation and backlog priority already write with the service role.
--
-- DEPLOY ORDER: apply this only AFTER the code that writes results with the
-- service role is live. Before that code, the browser wrote mastery results
-- through the learner's session, and this migration refuses those writes.

BEGIN;

REVOKE INSERT, UPDATE ON public.milestones FROM PUBLIC, anon, authenticated;

-- A table-level REVOKE does not remove column-level grants made earlier.
-- Clear those too, then grant back only the allowlist above.
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
    FROM pg_attribute
    WHERE attrelid = 'public.milestones'::regclass
      AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE INSERT (%s), UPDATE (%s) ON public.milestones FROM PUBLIC, anon, authenticated',
                 cols, cols);
END $$;

GRANT UPDATE (kanban_column, position, learning_points, coverage, summary_doc, summary_doc_at)
  ON public.milestones TO authenticated;
GRANT INSERT (track_id, title, summary, kanban_column, position)
  ON public.milestones TO authenticated;

COMMIT;
