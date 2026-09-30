# S6: blocked-account access

Migration 055 adds a restrictive account-status policy to 26 owned data tables
and the `note-images` and `monitor-documents` Storage buckets. A session remains
cryptographically valid after an administrator blocks an account, but direct
Supabase reads and writes now check the current `profiles.approved` and
`profiles.is_blocked` values on every statement. A blocked or unapproved account
cannot read or change its product data or obtain new personal-file access.
The profile row stays readable so the blocked page can show the account status.

API routes that use `getAuthenticatedUserId` also check live profile status
before reaching service-role operations. Notes and Monitor provisioning checks
include the same status. Admin actions require an active administrator. The
separate self-deletion route intentionally remains available to blocked users;
it requires an authenticated session and typed-email confirmation, then uses
the service role to delete the account. Existing signed URLs cannot be revoked
retroactively; they expire at their previously issued lifetime.

## Validation

The disposable PostgreSQL fixture creates two synthetic tenants, applies 055,
and keeps tenant A's session claim unchanged across an administrator block. It
checks that an active account can read, write and upload; the blocked account
loses Notes, other owned data and personal-file access; an unapproved account
is also denied; the profile remains readable; and service-role deletion retains
access. CI runs this fixture without production credentials. Unit tests cover
the API status gate and provisioned surfaces. No real account is blocked by
these tests.

## Production rollout

1. Merge the application and migration release after CI passes. The app gate
   starts protecting service-role API routes immediately.
2. Apply `supabase/migrations/055_blocked_account_access.sql` once in the Sydney
   Supabase SQL editor. It is transactional and forward-only. Confirm 050 and
   054 are present first. The restrictive policy takes effect immediately for
   existing sessions; no sign-out is required.
3. With a dedicated synthetic test account whose data may be used for this
   purpose, verify an authenticated read and upload before blocking, block it
   through the admin action, and retry with the same session. Reads, writes,
   uploads and new signed-file requests must fail; profile status and
   self-deletion must remain available. Unblock the test account afterward.

Until migration 055 is applied, direct Supabase requests with an existing
session can still use the older RLS policies. The API gate alone does not close
that path. S7 addresses the separate direct-upload size/type bypass for
otherwise active, provisioned accounts.
