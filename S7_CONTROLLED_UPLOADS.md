# S7: controlled personal-file uploads

The existing Notes and Monitor upload routes use the service-role Storage
client, validate ownership, and cap files at 10 MB for images and 5 MB for
documents. Before this change, provisioned accounts could bypass those routes
by uploading directly to either private bucket with their own Supabase session.
Production bucket settings were read on 2026-09-30: both had null size and MIME
restrictions.

Migration 056 sets bucket size and MIME limits to match the routes. It removes
the two direct INSERT policies and adds a restrictive policy that denies
authenticated direct uploads to both personal-file buckets even if another
permissive policy is added later. Other buckets are unaffected. Server routes
continue to upload with the service role. The routes now check file headers
before upload as well as browser-reported MIME types. DOCX and ODT share a ZIP
container signature; this check does not fully parse either format.

## Validation

The disposable PostgreSQL fixture exercises direct authenticated INSERTs to
both buckets, an unrelated bucket, and service-role uploads. It also checks
that bucket MIME and size settings match the route limits. CI runs this fixture
without production credentials. Header tests cover every allowed file type and
reject mismatched or truncated input. No production files are used in tests.

## Production rollout

1. Merge the application and migration release after CI passes. Header checks
   begin protecting application uploads immediately.
2. Apply `supabase/migrations/056_controlled_storage_uploads.sql` once in the
   Sydney Supabase SQL editor. It is transactional and forward-only. Apply 055
   first so blocked-account access is already revoked.
3. Read back both bucket settings. With a dedicated synthetic, provisioned
   test account, direct client uploads to both buckets should fail while the
   ordinary Notes and Monitor upload routes still succeed. Test an unsupported
   MIME type and an oversized file against Storage itself, without using real
   personal documents.

Controlled routes still have no total per-user storage allocation. That is a
separate capacity decision; this release closes the direct bypass that could
create arbitrary untracked objects outside those routes.

Travis applied migration 056 to Sydney on 2026-09-30. A production read-back
confirmed the 10 MB image and 5 MB document limits and the expected MIME lists.
The authenticated direct-upload and controlled-route tests in step 3 remain
pending.
