-- Run only in a disposable database. Both tenants use synthetic UUIDs.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_s6_security_test' THEN
    RAISE EXCEPTION 'This fixture requires hugh_s6_security_test';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role BYPASSRLS;
  END IF;
END $$;
CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public, auth, storage TO authenticated, service_role;

CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY,
  approved boolean NOT NULL,
  is_blocked boolean NOT NULL
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select_own ON public.profiles FOR SELECT TO authenticated
  USING (user_id = auth.uid());
GRANT SELECT ON public.profiles TO authenticated;
INSERT INTO public.profiles VALUES
  ('11111111-1111-4111-8111-111111111111', true, false),
  ('22222222-2222-4222-8222-222222222222', true, false);

-- Give every named table a permissive owner policy. The migration must add a
-- restrictive account check to every one, including unrelated owned data.
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
    EXECUTE format('CREATE TABLE public.%I (id uuid PRIMARY KEY, user_id uuid NOT NULL, payload text)', table_name);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY owner_access ON public.%I FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())', table_name);
    EXECUTE format('GRANT ALL ON public.%I TO authenticated, service_role', table_name);
    EXECUTE format('INSERT INTO public.%I VALUES ($1, $1, $2), ($3, $3, $2)', table_name)
      USING '11111111-1111-4111-8111-111111111111'::uuid, 'existing', '22222222-2222-4222-8222-222222222222'::uuid;
  END LOOP;
END $$;

CREATE TABLE storage.objects (id uuid PRIMARY KEY, bucket_id text, name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_files ON storage.objects FOR ALL TO authenticated
  USING (split_part(name, '/', 1) = auth.uid()::text)
  WITH CHECK (split_part(name, '/', 1) = auth.uid()::text);
GRANT ALL ON storage.objects TO authenticated, service_role;
INSERT INTO storage.objects VALUES
  ('11111111-1111-4111-8111-111111111111', 'note-images', '11111111-1111-4111-8111-111111111111/a.png'),
  ('22222222-2222-4222-8222-222222222222', 'monitor-documents', '22222222-2222-4222-8222-222222222222/a.pdf');

\ir ../migrations/055_blocked_account_access.sql

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
  WHERE schemaname = 'public' AND policyname = 'account_active_access';
  IF n <> 26 THEN RAISE EXCEPTION 'Expected 26 guarded data tables, got %', n; END IF;
  RAISE NOTICE 'PASS all 26 owned data tables have the restrictive policy';
END $$;

-- Keep the same authenticated session claim throughout the status changes.
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.notes;
  IF n <> 1 THEN RAISE EXCEPTION 'Active owner could not read own notes'; END IF;
  INSERT INTO public.notes VALUES ('33333333-3333-4333-8333-333333333333', auth.uid(), 'new');
  INSERT INTO storage.objects VALUES ('33333333-3333-4333-8333-333333333333', 'note-images', auth.uid()::text || '/new.png');
  RAISE NOTICE 'PASS active account can read, write and upload';
END $$;
RESET ROLE;

UPDATE public.profiles SET is_blocked = true
WHERE user_id = '11111111-1111-4111-8111-111111111111';
SET ROLE authenticated;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.notes;
  IF n <> 0 THEN RAISE EXCEPTION 'Blocked account read notes'; END IF;
  SELECT count(*) INTO n FROM public.monitor_skills;
  IF n <> 0 THEN RAISE EXCEPTION 'Blocked account read other owned data'; END IF;
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'note-images';
  IF n <> 0 THEN RAISE EXCEPTION 'Blocked account read personal files'; END IF;
  SELECT count(*) INTO n FROM public.profiles;
  IF n <> 1 THEN RAISE EXCEPTION 'Blocked account lost its status profile'; END IF;
  BEGIN
    INSERT INTO public.notes VALUES ('44444444-4444-4444-8444-444444444444', auth.uid(), 'bad');
    RAISE EXCEPTION 'Blocked account inserted a note';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO storage.objects VALUES ('44444444-4444-4444-8444-444444444444', 'note-images', auth.uid()::text || '/bad.png');
    RAISE EXCEPTION 'Blocked account uploaded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS same valid session loses owned data and Storage access after block';
END $$;
RESET ROLE;

UPDATE public.profiles SET is_blocked = false, approved = false
WHERE user_id = '11111111-1111-4111-8111-111111111111';
SET ROLE authenticated;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.notes;
  IF n <> 0 THEN RAISE EXCEPTION 'Unapproved account read notes'; END IF;
  RAISE NOTICE 'PASS unapproved account is also denied';
END $$;
RESET ROLE;

SET ROLE service_role;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.notes
  WHERE user_id = '11111111-1111-4111-8111-111111111111';
  IF n <> 2 THEN RAISE EXCEPTION 'Service-role account deletion lost data access'; END IF;
  RAISE NOTICE 'PASS service-role account deletion retains access';
END $$;
RESET ROLE;
