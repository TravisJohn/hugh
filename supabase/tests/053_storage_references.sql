-- DESTRUCTIVE FIXTURE SETUP: run ONLY in an empty disposable PostgreSQL database
-- named hugh_s1_security_test. No production connection is needed or permitted.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'hugh_s1_security_test' THEN
    RAISE EXCEPTION 'This fixture requires the disposable hugh_s1_security_test database';
  END IF;
END $$;

CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
CREATE TABLE storage.objects (id uuid PRIMARY KEY, bucket_id text, name text);
CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
  $$ SELECT string_to_array($1, '/') $$;
CREATE TABLE profiles (user_id uuid PRIMARY KEY REFERENCES auth.users, is_admin boolean);
GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

\ir ../migrations/027_notes.sql
\ir ../migrations/028_note_image_threads.sql
\ir ../migrations/030_note_image_flag.sql
\ir ../migrations/034_notes_grouping.sql
\ir ../migrations/037_monitor.sql
\ir ../migrations/039_monitor_application_events.sql
\ir ../migrations/040_monitor_documents.sql
\ir ../migrations/042_monitor_document_files.sql

INSERT INTO auth.users VALUES
 ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
INSERT INTO profiles SELECT id, true FROM auth.users;
\ir ../migrations/050_surface_provisioning.sql
INSERT INTO notebooks (id, user_id) SELECT id, id FROM auth.users;
INSERT INTO notes (id, user_id, notebook_id) SELECT id, id, id FROM auth.users;
INSERT INTO note_images (id, user_id, note_id, storage_path, mime)
 SELECT id, id, id, id::text || '/note/file.png', 'image/png' FROM auth.users;
INSERT INTO monitor_documents (id, user_id, kind, label)
 SELECT id, id, 'resume', 'Synthetic CV' FROM auth.users;
INSERT INTO monitor_document_versions (id, document_id, user_id, version, file_path)
 SELECT id, id, id, 1, id::text || '/doc/file.pdf' FROM auth.users;

-- Legacy poisoned reference must not prevent the permission fix from landing.
INSERT INTO note_images (user_id, note_id, storage_path, mime) VALUES (
 '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
 '22222222-2222-4222-8222-222222222222/note/private.png', 'image/png');
-- Simulate historical column grants as well as normal broad table grants.
GRANT UPDATE (storage_path), INSERT (storage_path) ON note_images TO PUBLIC;
GRANT UPDATE (file_path), INSERT (file_path) ON monitor_document_versions TO authenticated;
\ir ../migrations/053_protect_storage_references.sql

CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;

SELECT pg_temp.assert_true(NOT has_any_column_privilege('authenticated', 'note_images', 'INSERT'), 'client image inserts denied');
SELECT pg_temp.assert_true(NOT has_any_column_privilege('authenticated', 'monitor_document_versions', 'INSERT'), 'client version inserts denied');
SELECT pg_temp.assert_true(NOT has_column_privilege('authenticated', 'note_images', 'storage_path', 'UPDATE'), 'path update denied including PUBLIC grant');
SELECT pg_temp.assert_true(NOT has_column_privilege('authenticated', 'note_images', 'user_id', 'UPDATE'), 'owner update denied');
SELECT pg_temp.assert_true(NOT has_column_privilege('authenticated', 'note_images', 'parent_image_id', 'UPDATE'), 'parent update denied');
SELECT pg_temp.assert_true(NOT has_column_privilege('authenticated', 'monitor_document_versions', 'file_path', 'UPDATE'), 'version path update denied including column grant');
SELECT pg_temp.assert_true(NOT has_any_column_privilege('anon', 'note_images', 'UPDATE'), 'anonymous image updates denied');
SELECT pg_temp.assert_true(has_column_privilege('authenticated', 'note_images', 'title', 'UPDATE'), 'title updates permitted');
SELECT pg_temp.assert_true(has_column_privilege('authenticated', 'monitor_document_versions', 'note', 'UPDATE'), 'version note updates permitted');

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$ DECLARE n int; BEGIN
  BEGIN
    UPDATE note_images SET storage_path = '22222222-2222-4222-8222-222222222222/note/file.png'
      WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: replaced image reference';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: direct image path replacement refused'; END;
  BEGIN
    UPDATE monitor_document_versions SET file_path = '22222222-2222-4222-8222-222222222222/doc/file.pdf'
      WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: replaced document reference';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: direct document path replacement refused'; END;
  BEGIN
    INSERT INTO note_images (user_id, note_id, storage_path, mime) VALUES
      (auth.uid(), auth.uid(), auth.uid()::text || '/note/new.png', 'image/png');
    RAISE EXCEPTION 'FAIL: client inserted file reference';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: direct reference insertion refused'; END;
  UPDATE note_images SET title = 'My title', flag = 'green', position = 2 WHERE id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: own metadata update'; END IF;
  RAISE NOTICE 'PASS: own title, flag and ordering edits work';
  UPDATE note_images SET title = 'Not mine' WHERE id = '22222222-2222-4222-8222-222222222222';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: other tenant metadata changed'; END IF;
  RAISE NOTICE 'PASS: other tenant metadata remains protected by RLS';
  UPDATE monitor_document_versions SET note = 'My note' WHERE id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: own version note update'; END IF;
END $$;
RESET ROLE;

SET ROLE service_role;
DO $$ BEGIN
  INSERT INTO note_images (user_id, note_id, storage_path, mime) VALUES (
    '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111/note/server.png', 'image/png');
  UPDATE note_images SET storage_path = user_id::text || '/note/promoted.png'
    WHERE id = '11111111-1111-4111-8111-111111111111';
  RAISE NOTICE 'PASS: server uploads and promotion remain writable';
  BEGIN
    UPDATE note_images SET storage_path = user_id::text || '/../other/file.png'
      WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: server traversal accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: traversal rejected even for service role'; END;
  BEGIN
    UPDATE monitor_document_versions SET file_path = '22222222-2222-4222-8222-222222222222/doc/file.pdf'
      WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: server foreign file accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: foreign document rejected even for service role'; END;
END $$;
RESET ROLE;
\ir ../checks/053_storage_references.sql
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM note_images WHERE split_part(storage_path, '/', 1) <> user_id::text), 'legacy mismatch preserved for investigation');
-- Synthetic cleanup only, to prove constraint validation works after repair.
DELETE FROM note_images WHERE split_part(storage_path, '/', 1) <> user_id::text;
ALTER TABLE note_images VALIDATE CONSTRAINT note_images_owned_storage_path;
ALTER TABLE monitor_document_versions VALIDATE CONSTRAINT monitor_versions_owned_file_path;
SELECT 'S1 database checks passed' AS result;
