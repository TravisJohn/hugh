-- Run only in a disposable database; no real files or Supabase credentials.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_s7_security_test' THEN
    RAISE EXCEPTION 'This fixture requires hugh_s7_security_test';
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
GRANT USAGE ON SCHEMA auth, storage TO authenticated, service_role;

CREATE TABLE storage.buckets (
  id text PRIMARY KEY, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]
);
CREATE TABLE storage.objects (id uuid PRIMARY KEY, bucket_id text, name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT INSERT, SELECT ON storage.objects TO authenticated, service_role;
INSERT INTO storage.buckets (id, name, public) VALUES
  ('note-images', 'note-images', false),
  ('monitor-documents', 'monitor-documents', false),
  ('other', 'other', false);

CREATE POLICY note_images_storage_owner_insert ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'note-images' AND split_part(name, '/', 1) = auth.uid()::text
  );
CREATE POLICY monitor_documents_storage_owner_insert ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'monitor-documents' AND split_part(name, '/', 1) = auth.uid()::text
  );
CREATE POLICY other_owner_insert ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'other' AND split_part(name, '/', 1) = auth.uid()::text
  );

\ir ../migrations/056_controlled_storage_uploads.sql

DO $$
DECLARE size_limit bigint; allowed text[];
BEGIN
  SELECT file_size_limit, allowed_mime_types INTO size_limit, allowed
  FROM storage.buckets WHERE id = 'note-images';
  IF size_limit <> 10485760 OR allowed <> ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']::text[] THEN
    RAISE EXCEPTION 'Notes bucket limits differ from the API';
  END IF;
  SELECT file_size_limit, allowed_mime_types INTO size_limit, allowed
  FROM storage.buckets WHERE id = 'monitor-documents';
  IF size_limit <> 5242880 OR allowed <> ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword', 'application/rtf',
    'application/vnd.oasis.opendocument.text'
  ]::text[] THEN
    RAISE EXCEPTION 'Documents bucket limits differ from the API';
  END IF;
  RAISE NOTICE 'PASS both bucket size and MIME limits match the upload routes';
END $$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  BEGIN
    INSERT INTO storage.objects VALUES (
      '11111111-1111-4111-8111-111111111111', 'note-images',
      auth.uid()::text || '/direct.png');
    RAISE EXCEPTION 'Direct Notes upload was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO storage.objects VALUES (
      '22222222-2222-4222-8222-222222222222', 'monitor-documents',
      auth.uid()::text || '/direct.pdf');
    RAISE EXCEPTION 'Direct Monitor upload was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  INSERT INTO storage.objects VALUES (
    '33333333-3333-4333-8333-333333333333', 'other',
    auth.uid()::text || '/allowed.txt');
  RAISE NOTICE 'PASS direct personal uploads fail without affecting other buckets';
END $$;
RESET ROLE;

SET ROLE service_role;
INSERT INTO storage.objects VALUES (
  '44444444-4444-4444-8444-444444444444', 'note-images',
  '11111111-1111-4111-8111-111111111111/server.png');
INSERT INTO storage.objects VALUES (
  '55555555-5555-4555-8555-555555555555', 'monitor-documents',
  '11111111-1111-4111-8111-111111111111/server.pdf');
RESET ROLE;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM storage.objects
  WHERE bucket_id IN ('note-images', 'monitor-documents');
  IF n <> 2 THEN RAISE EXCEPTION 'Service-role controlled uploads failed'; END IF;
  RAISE NOTICE 'PASS service-role controlled uploads remain available';
END $$;
