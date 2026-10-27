-- 061: topic requests (narrow Learn, phase 2, PR C).
--
-- Once Learn teaches only from its catalog, a learner who wants a subject it
-- doesn't have can ask for it (PRD-narrow-learn.md, row 6). A request is a
-- short line Travis reads in /admin to choose the next packs. It makes no model
-- call and builds nothing, so it is not a route into track generation.
--
--   topic_requests   One row per request: who asked, what they asked for (1 to
--                    120 characters, stored trimmed), and when.
--
-- Server-written only, like 059's review tables. RLS is on, there is no
-- learner policy, and anon and authenticated hold no privilege at all. The
-- route checks the length and the 5-a-day limit (lib/learn/topicRequest.ts)
-- and then writes with the service role. A learner INSERT grant would let a
-- direct REST call skip that limit, so there is none. The admin reads with the
-- service role too.
--
-- Retention: kept until the account is deleted, like everything else a learner
-- made (lib/retention.ts). The auth.users cascade removes a learner's requests
-- with their account, so lib/account/deleteAccount.ts needs no change.
--
-- DEPLOY ORDER: apply this BEFORE the code that saves requests deploys. It
-- changes nothing for the code that is live now.

BEGIN;

CREATE TABLE IF NOT EXISTS public.topic_requests (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_topic TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stored trimmed, never blank, and no longer than the box allows.
ALTER TABLE public.topic_requests DROP CONSTRAINT IF EXISTS topic_requests_text_shape;
ALTER TABLE public.topic_requests
  ADD CONSTRAINT topic_requests_text_shape
  CHECK (requested_topic = btrim(requested_topic)
         AND char_length(requested_topic) BETWEEN 1 AND 120);

-- The daily limit counts one learner's recent requests; the admin list reads
-- newest first.
CREATE INDEX IF NOT EXISTS topic_requests_user_created_idx
  ON public.topic_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS topic_requests_created_idx
  ON public.topic_requests (created_at DESC);

ALTER TABLE public.topic_requests ENABLE ROW LEVEL SECURITY;

-- Supabase grants every new table to anon and authenticated by default.
-- Take that back: only the service role may touch this table.
REVOKE ALL ON public.topic_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.topic_requests TO service_role;

COMMIT;
