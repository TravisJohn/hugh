-- S1: a learner owns a metadata row, not every object it can point at.
-- Uploads/inserts and file replacement already use the server's service role.
-- Keep ordinary metadata edits, but make references and ownership server-owned.
BEGIN;

REVOKE INSERT, UPDATE ON public.note_images, public.monitor_document_versions
  FROM PUBLIC, anon, authenticated;

-- Table-level REVOKE does not remove pre-existing column grants. Clear those
-- too, then grant only the metadata that a learner is allowed to edit.
DO $$
DECLARE t text; cols text;
BEGIN
  FOREACH t IN ARRAY ARRAY['note_images', 'monitor_document_versions'] LOOP
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
      FROM pg_attribute
      WHERE attrelid = format('public.%I', t)::regclass
        AND attnum > 0 AND NOT attisdropped;
    EXECUTE format('REVOKE INSERT (%s), UPDATE (%s) ON public.%I FROM PUBLIC, anon, authenticated',
                   cols, cols, t);
  END LOOP;
END $$;

GRANT UPDATE (title, flag, position) ON public.note_images TO authenticated;
GRANT UPDATE (note) ON public.monitor_document_versions TO authenticated;

-- Match lib/storage/ownership.ts. No traversal, percent escapes, backslashes,
-- URLs, empty segments or prefix lookalikes. These also police server writes.
-- NOT VALID deliberately preserves existing records for investigation while
-- enforcing the constraint on every new/updated row. The API guards reject
-- unsafe old references. Audit and VALIDATE with supabase/checks/053_*.sql.
ALTER TABLE public.note_images
  ADD CONSTRAINT note_images_owned_storage_path CHECK (
    split_part(storage_path, '/', 1) = user_id::text
    AND storage_path ~ '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*)+$'
  ) NOT VALID;

ALTER TABLE public.monitor_document_versions
  ADD CONSTRAINT monitor_versions_owned_file_path CHECK (
    file_path IS NULL OR (
      split_part(file_path, '/', 1) = user_id::text
      AND file_path ~ '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*)+$'
    )
  ) NOT VALID;

COMMIT;
