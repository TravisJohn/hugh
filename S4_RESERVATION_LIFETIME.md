# S4: per-request reservation lifetime

Migration 054 replaces the shared expiry window in migration 049 with one expiry
per admitted token claim. The usage counter remains the row lock, so concurrent
admission stays atomic. The function signature and application call sites do
not change. Zero-token calls still use a rate slot without creating a token
claim.

At each admission, reserve_usage removes this account's expired claims for the
current period, sums claims that are still active, and checks spent + active +
new estimate against the limit. It records a positive new estimate with
expires_at = request time + the supplied TTL. The old reserved_tokens column is
a cached active total updated on admission; reserve_window_start is retained
for compatibility but no longer controls expiry. record_usage still adds actual
spend separately. A completed request can count as both spent and reserved until
its claim expires, as in migration 049; this is conservative and can cause a
temporary near-limit refusal.

During migration, any existing aggregate reserved_tokens is carried into one
legacy claim for another 150 seconds. Its constituent request times cannot be
recovered, so this short period may over-reserve but does not free a still-running
request. The new table is server-only and cascades when a counter is removed.

## Validation

Disposable PostgreSQL tests cover the exact t=0 / t=149 / t=150 example in the
security review, refusal just before t=299, admission at t=299, migration
cutover, rate limits, logged spend, permissions, and counter deletion. The
existing eight-way S2 near-limit concurrency fixture now also runs with
migration 054 applied. The full S1/S2/S4 database sequence passed locally.
CI runs the same isolated sequence without production credentials.

## Rollout

1. Review and merge the migration and CI fixture. It changes no running
   database until migration 054 is applied.
2. Pause billable admission and let in-flight requests finish, then apply 054
   once to the Sydney Supabase production database after confirming 049 is
   present. The migration is transactional and forward-only. It locks the
   counter while copying old claims. A call already executing the old function
   could otherwise resume after cutover, so use a quiet maintenance window.
3. Verify the new usage_reservations table and reserve_usage function, then run
   `node scripts/verify-054.mjs` from the production-configured checkout. It
   uses a synthetic period for the existing test learner and deletes its rows.
   Do not use a real billing period for the exercise.
4. Watch quota admission errors and database growth after cutover.

The existing 150-second TTL still does not cover a 900-second Realtime voice
session; that is S3's separate lifecycle issue. The wider non-atomic fallback on
RPC errors is S5. Expired rows for inactive accounts are retained until their
counter is cleaned up; active current-period rows are pruned during admission.
