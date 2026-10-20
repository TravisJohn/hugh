-- 060: tracks built from reference packs (narrow Learn, phase 1).
--
-- A pack track is laid out from a pack's authored cards with no model call
-- (PRD-narrow-learn.md, row 2). This migration gives that build somewhere to
-- record what it built from. It is purely additive.
--
--   milestones.concept_ids   The pack concepts a card teaches, each naming its
--                            pack: 'linear-regression:least_squares'. Empty on
--                            every card built any other way. Ask, mastery, the
--                            diary check and the quiz will ground a card in
--                            these (PR B), so a learner must not be able to
--                            write them. Since 058 a learner's session holds
--                            only named column grants on milestones, and this
--                            new column is granted to nobody, so only the
--                            service role (the track build) writes it.
--
--   learning_goals.pack_id,  Which course a goal is, and which version of it
--   learning_goals.pack_version  was built. For display and listing ONLY.
--                            Learners hold table-level UPDATE on
--                            learning_goals, so nothing may trust these to
--                            decide what a card is grounded in. That is what
--                            concept_ids is for.
--
--   source_kind 'pack'       Both learning_goals.source_kind and
--                            track_generations.source_kind allowed only 'qa'
--                            and 'document'. A pack build's provenance row
--                            would be refused without this.
--
-- DEPLOY ORDER: apply this BEFORE the code that builds pack tracks deploys.
-- It changes nothing for the code that is live now.

BEGIN;

ALTER TABLE public.milestones
  ADD COLUMN IF NOT EXISTS concept_ids TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.learning_goals
  ADD COLUMN IF NOT EXISTS pack_id      TEXT,
  ADD COLUMN IF NOT EXISTS pack_version TEXT;

-- A course goal names both its pack and the version it was built from; any
-- other goal names neither.
ALTER TABLE public.learning_goals DROP CONSTRAINT IF EXISTS learning_goals_pack_pair;
ALTER TABLE public.learning_goals
  ADD CONSTRAINT learning_goals_pack_pair
  CHECK ((pack_id IS NULL) = (pack_version IS NULL));

ALTER TABLE public.learning_goals DROP CONSTRAINT IF EXISTS learning_goals_source_kind_check;
ALTER TABLE public.learning_goals
  ADD CONSTRAINT learning_goals_source_kind_check
  CHECK (source_kind IN ('qa', 'document', 'pack'));

ALTER TABLE public.track_generations DROP CONSTRAINT IF EXISTS track_generations_source_kind_check;
ALTER TABLE public.track_generations
  ADD CONSTRAINT track_generations_source_kind_check
  CHECK (source_kind IN ('qa', 'document', 'pack'));

-- A goal is a course goal exactly when it names a pack.
ALTER TABLE public.learning_goals DROP CONSTRAINT IF EXISTS learning_goals_pack_source;
ALTER TABLE public.learning_goals
  ADD CONSTRAINT learning_goals_pack_source
  CHECK ((source_kind = 'pack') = (pack_id IS NOT NULL));

-- 058 grants learners only named milestone columns, and concept_ids is not
-- one of them. This clears any column grant on it as well. It cannot undo a
-- future TABLE-level grant, so never grant milestones back wholesale (058).
REVOKE INSERT (concept_ids), UPDATE (concept_ids) ON public.milestones FROM PUBLIC, anon, authenticated;

COMMIT;
