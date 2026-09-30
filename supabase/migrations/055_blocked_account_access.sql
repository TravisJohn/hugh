-- S6: a valid session must stop granting product data access after an account
-- is blocked or loses approval. Service-role account deletion remains separate.
-- Apply after 050 and 054. Forward-only migration.
BEGIN;

CREATE OR REPLACE FUNCTION public.account_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT p.approved AND NOT p.is_blocked
    FROM public.profiles AS p
    WHERE p.user_id = auth.uid()
  ), false);
$$;

REVOKE ALL ON FUNCTION public.account_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_active() TO authenticated;

-- RESTRICTIVE policies compose with every existing owner/provisioning policy.
-- They cannot be bypassed by a second permissive policy added later. Keep
-- profiles readable so the blocked page can show account state; the separate
-- self-deletion route uses the service role and remains available.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sessions', 'questions', 'answers', 'learning_goals',
    'tracks', 'milestones', 'milestone_entries', 'usage_logs',
    'point_status_events', 'case_attempts', 'pinned_thoughts',
    'code_drill_attempts', 'notebooks', 'notes', 'note_images',
    'note_messages', 'pending_document_extractions',
    'monitor_skills', 'monitor_skill_entries', 'monitor_applications',
    'monitor_application_events', 'monitor_documents',
    'monitor_document_versions', 'activity_events', 'learner_notes',
    'goal_answers'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS account_active_access ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY account_active_access ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (public.account_active()) WITH CHECK (public.account_active())',
      table_name
    );
  END LOOP;
END $$;

-- The two personal-file buckets also have owner and provisioning policies.
-- This restrictive policy revokes SELECT, INSERT, UPDATE and DELETE with the
-- same existing session, even if another permissive Storage policy is added.
DROP POLICY IF EXISTS account_active_personal_files ON storage.objects;
CREATE POLICY account_active_personal_files ON storage.objects
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    bucket_id NOT IN ('note-images', 'monitor-documents')
    OR public.account_active()
  )
  WITH CHECK (
    bucket_id NOT IN ('note-images', 'monitor-documents')
    OR public.account_active()
  );

COMMIT;
