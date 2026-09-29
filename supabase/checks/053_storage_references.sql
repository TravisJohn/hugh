-- Read-only census: returns counts, not private paths or content.
SELECT 'note_images' AS source, count(*) AS invalid_references
FROM public.note_images
WHERE NOT (
  split_part(storage_path, '/', 1) = user_id::text
  AND storage_path ~ '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*)+$'
)
UNION ALL
SELECT 'monitor_document_versions', count(*)
FROM public.monitor_document_versions
WHERE file_path IS NOT NULL AND NOT (
  split_part(file_path, '/', 1) = user_id::text
  AND file_path ~ '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*)+$'
);

-- Once both counts are zero, run separately:
-- ALTER TABLE public.note_images VALIDATE CONSTRAINT note_images_owned_storage_path;
-- ALTER TABLE public.monitor_document_versions VALIDATE CONSTRAINT monitor_versions_owned_file_path;
-- Investigate nonzero counts; never guess the owner or automatically delete
-- objects based on a mismatched reference.
