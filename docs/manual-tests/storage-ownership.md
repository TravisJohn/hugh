# S1 storage ownership fix

Implemented: canonical owner checks before privileged signing, Coach
downloads, screenshot promotion and file cleanup. Migration 053 makes file
references server-managed, retains permitted metadata edits, and constrains new
or updated references to their row owner's folder.

## Verification

- `npx vitest run lib/storage` runs 36 ownership and actual route-handler tests.
  Database/Storage/provider calls are mocked; no billable calls or real files.
- `supabase/tests/053_storage_references.sql` applies the relevant real migrations
  to an empty disposable PostgreSQL database and tests permissions with two
  synthetic users. It rejects any database name other than
  `hugh_s1_security_test`. **Never run the fixture in Supabase production.**
- CI's `storage-security` job runs that fixture in a disposable PostgreSQL service.
- `npx tsx scripts/audit-storage-references.ts` is a read-only, paginated census
  against the configured Supabase project. It prints counts only. On 29 September
  2026, the production census checked 1,064 screenshot references and 11 document
  file references: zero invalid references. This checks present references, not
  historical access or evidence of a breach.

## Production rollout

Travis confirmed migration 053 was applied on 29 September 2026. Application
release verification is being completed with the S1 merge. Constraint validation
and manual UI checks below are not independently confirmed.

1. Deploy the application ownership guards. They reject unsafe legacy references
   even before the database migration is applied.
2. Apply `supabase/migrations/053_protect_storage_references.sql` through the
   Supabase SQL editor or the existing migration runner. No files or rows are
   deleted. Creation and reference changes remain available to the service role;
   authenticated clients retain SELECT/DELETE and only these direct UPDATEs:
   image title/flag/position, and document-version note.
3. Run `supabase/checks/053_storage_references.sql`. If both counts are zero,
   execute its two commented VALIDATE CONSTRAINT statements. If nonzero,
   investigate instead of automatically changing a path or deleting a file.
4. Confirm legitimate image upload/view/rename/flag/reorder/promote/delete,
   notebook cleanup, and document upload/download still work. The migration does
   not require any client UI changes: the existing upload paths use the server.

Migration 053 was tested independently in disposable PostgreSQL; production
application is confirmed by Travis. The optional validation of existing rows
does not defer enforcement on new/updated rows or the application's ownership
checks. SUPABASE_ACCESS_TOKEN is not configured locally.
