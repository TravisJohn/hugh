-- S7: only server routes may upload to the two personal-file buckets.
-- The routes check ownership, type and size before using the service role.
-- Bucket limits add a second check at Storage itself. Forward-only migration.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'note-images')
     OR NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'monitor-documents') THEN
    RAISE EXCEPTION 'Both personal-file buckets must exist before migration 056';
  END IF;
END $$;

UPDATE storage.buckets
SET file_size_limit = 10485760,
    allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']::text[]
WHERE id = 'note-images';

UPDATE storage.buckets
SET file_size_limit = 5242880,
    allowed_mime_types = ARRAY[
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/rtf',
      'application/vnd.oasis.opendocument.text'
    ]::text[]
WHERE id = 'monitor-documents';

DROP POLICY IF EXISTS note_images_storage_owner_insert ON storage.objects;
DROP POLICY IF EXISTS monitor_documents_storage_owner_insert ON storage.objects;

-- A restrictive policy prevents another permissive policy from accidentally
-- reopening direct uploads. Service-role uploads bypass RLS and still work.
DROP POLICY IF EXISTS server_only_personal_uploads ON storage.objects;
CREATE POLICY server_only_personal_uploads ON storage.objects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (bucket_id NOT IN ('note-images', 'monitor-documents'));

COMMIT;
