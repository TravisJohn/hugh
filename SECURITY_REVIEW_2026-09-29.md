# Hugh: independent security and deployment review

Review date: 29 September 2026.

Follow-up: **S1 is complete.** The fix was integrated into main as `b84b05e`;
both CI jobs passed and Vercel reported a successful deployment. Travis confirmed
production migration 053 was applied on 29 September 2026. A read-only census
found zero invalid references among 1,064 screenshots and 11 document files.
S2-S9 remain open. See [S1 rollout and verification](<D:/WEB PROJECTS/hugh/docs/manual-tests/storage-ownership.md>).

**Assessment: fix the access-control and spending-control findings before opening this deployment to an untrusted public audience.** The project has useful defenses, but passing its current tests is not evidence that its tenant boundaries or financial limits hold against direct requests.

This is a source and dependency review of the current working tree, not a penetration test of the live deployment. No production records were read or changed, no billable model calls were made, and no application code was changed. Existing PROJECT_LOG.md and PRD-track-brief.md work was preserved. The earlier DEPLOYMENT_READINESS_AUDIT.md was consulted after the initial independent inspection; its old findings are not assumed to remain open.

## Findings

### S1 - High: editable file references let the server act on another user's files

**Status: resolved in b84b05e; deployed. Migration 053 applied per Travis.**
The finding below is retained as the original evidence, not a current open issue.

Evidence: [current Notes policies](<D:/WEB PROJECTS/hugh/supabase/migrations/050_surface_provisioning.sql:121>), [document-version policy](<D:/WEB PROJECTS/hugh/supabase/migrations/050_surface_provisioning.sql:142>), [image URL signing](<D:/WEB PROJECTS/hugh/app/api/notes/images/route.ts:41>), [image deletion](<D:/WEB PROJECTS/hugh/app/api/notes/images/route.ts:320>), [document URL signing](<D:/WEB PROJECTS/hugh/app/api/monitor/documents/file/route.ts:41>).

The policies allow a provisioned user to update their own note_images and monitor_document_versions rows. They do not constrain storage_path or file_path to that user's storage prefix. These columns have no equivalent ownership constraint in the migrations. The API filters the database row by user_id, then uses the service-role client to sign or remove the path stored in that row. Owning the row is not proof of owning the referenced object.

A provisioned attacker who knows another user's object path can put that path in their own row through Supabase's REST API. Requesting their own image/version then obtains a fresh signed download for the victim's file. Deleting their own poisoned image can remove the victim's screenshot. Notes Coach also downloads these paths with service privileges before sending the bytes to OpenAI. This does not demonstrate an ability to enumerate unknown paths; UUID filenames make guessing difficult. However, a path disclosed through a previously shared or expired signed URL must not become permanent authorization.

This is a source-confirmed authorization defect under the write grants the supplied migrations are designed to use. Actual deployed grants were not inspected. Supabase explicitly documents that service keys bypass Storage RLS: [Storage access control](https://supabase.com/docs/guides/storage/security/access-control).

**Fix:** make storage references server-managed; revoke direct client writes to sensitive columns, or route all such writes through constrained server operations. Validate a canonical owner prefix on every sign, download and delete as defense in depth. Prefer a user-scoped Storage client where possible. Validate existing references before trusting them. Prove the fix with two synthetic tenants: A's row pointing at B's object must never yield a URL, bytes, or deletion.

### S2 - High: model input size is not bounded by the quota reservation

Evidence: [Learn chat input](<D:/WEB PROJECTS/hugh/app/api/learn/chat/route.ts:34>), [Code chat input](<D:/WEB PROJECTS/hugh/app/api/code/chat/route.ts:39>), [Cloud chat input](<D:/WEB PROJECTS/hugh/app/api/cloud/chat/route.ts:74>), [fixed estimates](<D:/WEB PROJECTS/hugh/lib/tokenBudget.ts:133>).

These handlers limit the number of messages to 20 or 12 but do not limit the length of each message or total model input. Learn's topic is also unbounded. TypeScript casts do not validate the received JSON. The usage gate reserves only 6,000 tokens for Learn or 3,000 for Code/Cloud, before examining the request. max_tokens bounds model output, not input.

An approved account can submit a large valid prompt, within provider and platform limits, that costs substantially more than the reservation. Concurrent requests can all reserve their small estimate before the much larger real charges arrive. Logging after completion does not prevent that overspend. Malformed roles/content also reach the provider or throw errors instead of being rejected consistently.

**Fix:** validate role/content types and impose per-field, per-message and aggregate limits before reserving budget. Reserve from a conservative input-token bound plus maximum output and possible retries. Add concurrent near-limit tests using oversized valid prompts and verify that refusal occurs before any provider call.

### S3 - High when enabled: Realtime usage and session limits are controlled by the browser

Evidence: [credential minting](<D:/WEB PROJECTS/hugh/app/api/tracker/mastery/realtime-session/route.ts:107>), [browser-supplied usage](<D:/WEB PROJECTS/hugh/app/api/tracker/mastery/realtime-usage/route.ts:79>), [browser timer](<D:/WEB PROJECTS/hugh/hooks/useMasteryRealtime.ts:183>), [reservation lifetime](<D:/WEB PROJECTS/hugh/lib/tokenBudget.ts:61>).

The server supplies a Realtime credential and then relies on the browser to report usage and close the connection at the app's deadline. A modified client can omit the usage request or report zero. Clamping the maximum reported number cannot detect under-reporting. The 6,000-token reservation expires after 150 seconds, whereas the app allows a 900-second session. Budget therefore becomes available again while even a legitimate voice session may still be running.

There is no durable server session record tying the credential, final charge, expiry and one-time reconciliation together. The credential's expires_after value should not be treated as server enforcement of the application's active-session timer. Even without extending any provider session limit, repeated sessions with omitted accounting bypass the application's monthly cap.

**Exposure:** conditional on MASTERY_REALTIME_ENABLED=true. The example environment defaults to false; the production value was not verified.

**Fix:** keep the feature disabled for public users until sessions and spend are accounted for server-side. Use provider-supported server observation/control, a durable session ID, conservative upfront charging until verified reconciliation, and an enforced concurrency/lifetime policy. A browser crash or deliberately missing report must not refund consumed budget.

### S4 - Medium: reservation expiry can discard a request's budget almost immediately

Evidence: [shared reservation window](<D:/WEB PROJECTS/hugh/supabase/migrations/049_usage_counters.sql:144>), [reservation update](<D:/WEB PROJECTS/hugh/supabase/migrations/049_usage_counters.sql:198>).

reserve_window_start belongs to the entire counter, not each request. Adding a reservation does not advance that timestamp. At window expiry, reserve_usage clears every reservation, including those made immediately before expiry. This contradicts the assumption that each reservation survives longer than a request.

Source-derived example, with an initially unused 6,000-token allowance: a TTS request at t=0 creates the counter with a zero-token reservation; a Learn request at t=149 reserves 6,000; another Learn request at t=150 clears the first reservation and reserves 6,000 again while the first call is still running. Both calls can spend. The SQL row lock prevents simultaneous compare-and-increment races, but not this expiry error.

**Fix:** track each reservation with its own expiry and reconcile it once. A simpler conservative alternative must ensure every still-running reservation remains counted; retain tests for arrivals just before and after the expiry boundary. The example above was traced through the SQL, not executed against production.

### S5 - Medium: a quota RPC error silently removes rate limiting

Evidence: [fallback branch](<D:/WEB PROJECTS/hugh/lib/usage.ts:226>), [legacy check](<D:/WEB PROJECTS/hugh/lib/usage.ts:255>).

Any reserve_usage error falls back to a sum of usage_logs. That fallback has no request-rate limit and no atomic reservation. Pro/admin accounts are allowed immediately. Thus an unapplied migration or RPC failure removes abuse controls while model calls continue. The free-account sum also lacks pagination, so sufficiently many rows can be omitted under the deployment's PostgREST row-return limit.

This does not bypass the earlier approval/block check, and the legacy query does reject on a read error. The specific problem is losing rate and concurrency enforcement during a partial failure.

**Fix:** fail closed with a temporary-unavailable response for billable operations when atomic admission is unavailable. Verify the required migration before enabling traffic. If a fallback is required, it needs equivalent durable rate and budget guarantees.

### S6 - Medium: blocking an account does not revoke its data/upload access

Evidence: [block action](<D:/WEB PROJECTS/hugh/app/api/admin/users/[userId]/route.ts:38>), [provisioning columns](<D:/WEB PROJECTS/hugh/lib/auth/provisioning.ts:37>), [Notes upload gate](<D:/WEB PROJECTS/hugh/app/api/notes/images/route.ts:108>), [database provisioning predicates](<D:/WEB PROJECTS/hugh/supabase/migrations/050_surface_provisioning.sql:84>).

Blocking changes profiles.is_blocked. Paid AI routes inspect it, but Notes/Monitor CRUD checks authentication and provisioning only. Their database and Storage policies also omit blocked/approved state. A previously provisioned blocked account can retain a valid login and keep uploading, modifying data and obtaining signed files through direct requests. Other owner-only tables similarly permit direct access independently of the page redirect.

**Fix:** define which operations blocked users may retain, then enforce that rule in API gates and database/Storage policies. At minimum, deny new uploads and writes from blocked accounts. Preserve deliberate account-deletion/export access separately. Test a valid pre-block session after applying the block action.

### S7 - Medium: direct Storage uploads bypass application upload restrictions

Evidence: [route size/type checks](<D:/WEB PROJECTS/hugh/app/api/notes/images/route.ts:133>), [Storage INSERT policy](<D:/WEB PROJECTS/hugh/supabase/migrations/050_surface_provisioning.sql:169>), [Notes bucket creation](<D:/WEB PROJECTS/hugh/supabase/migrations/027_notes.sql:87>), [document bucket creation](<D:/WEB PROJECTS/hugh/supabase/migrations/042_monitor_document_files.sql:45>).

A provisioned user's authenticated Supabase client may upload directly into their own storage prefix. That bypasses Next.js's file-size/type checks. The checked-in bucket definitions set neither file_size_limit nor allowed_mime_types, and there is no enforced per-user total storage quota. The provider's global limits still apply; this is not literally unlimited storage. Live bucket settings could mitigate size/type exposure, but were not inspected.

An account can therefore consume storage outside the application's intended flow, including objects with no associated application record. The API's maximum number of snips is not a storage allocation limit.

**Fix:** enforce supported MIME types and object-size ceilings on the bucket, then add a per-user allocation/rate policy or remove general direct-upload permission and use controlled uploads. Check file signatures where content type matters. Test the direct Supabase path, not just the upload form.

### S8 - Medium: TTS has a rate limit but no cumulative allowance

Evidence: [zero-token TTS reservation](<D:/WEB PROJECTS/hugh/lib/tokenBudget.ts:157>), [character-only accounting](<D:/WEB PROJECTS/hugh/lib/usage.ts:172>), [TTS text limit](<D:/WEB PROJECTS/hugh/app/api/tts/route.ts:52>).

TTS reserves zero tokens and records tts_chars, which the monthly gate does not count. A free account below its token limit can repeatedly request up to 2,000 characters per call. The 30-request/minute shared rate limit bounds speed, but not the cumulative character consumption or financial exposure. A user can consume the shared ElevenLabs allowance without exhausting their own Hugh allowance. Any provider-side cap may bound the bill while still causing a service outage for other learners.

**Fix:** reserve and reconcile a character or monetary allowance for TTS, with an appropriate daily/monthly cap. Confirm provider-level spend/overage settings separately. Open signup and automatic approval make per-account and global controls especially relevant; auto-approval itself appears intentional and is not classified here as a privilege-escalation bug.

### S9 - Moderate advisory: production dependency undici 7.29.0 needs a security update

npm audit --omit=dev reports one moderate vulnerability, no high or critical advisories. npm ls resolves cheerio@1.2.0 -> undici@7.29.0; the lockfile pins the affected version at [package-lock.json](<D:/WEB PROJECTS/hugh/package-lock.json:11253>).

[The upstream advisory](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v) describes a process-crashing WebSocket decompression error, fixed in undici 7.29.1 on the 7.x line. Exploitation requires an affected WebSocket client connecting to a malicious or compromised peer. This review did not establish that reachable attack path through Hugh's Cheerio usage, so this is a dependency finding, not a demonstrated remote crash of Hugh.

**Fix:** update the compatible transitive dependency and lockfile, then rerun audit and CI. Do not assume the package update also patches a Node runtime's separately bundled copy.

## Additional issues and deployment checks

- **Parent ownership is not consistently enforced.** Some denormalized child tables check their own user_id without proving that the referenced parent belongs to the same user. For example, [Monitor status changes](<D:/WEB PROJECTS/hugh/app/api/monitor/applications/[id]/route.ts:100>) insert an event before confirming ownership of the application, and resume/cover-letter version IDs are accepted based only on FK existence. A foreign-key UUID is not an authorization check. Add composite ownership constraints and check the parent before mutations. This review does not claim that those event rows are displayed to the victim; their reads also filter user_id.
- **Account storage deletion is incomplete for larger or differently shaped inventories.** [listUserObjects](<D:/WEB PROJECTS/hugh/lib/account/deleteAccount.ts:73>) lists only the first 1,000 entries at each of two levels, without pagination or deeper traversal. Direct uploads can create other layouts. Depending on Storage ownership metadata, this can leave objects behind or prevent account deletion from finishing. Use a complete paginated traversal and verify storage is empty before declaring completion.
- **CSP is observation-only.** [next.config.ts](<D:/WEB PROJECTS/hugh/next.config.ts:41>) sends Content-Security-Policy-Report-Only, with no report destination. It does not enforce restrictions. Its script policy also allows unsafe-inline and unsafe-eval. This is a hardening gap, not proof of an exploitable XSS. Trial and then enforce an appropriate policy; treat same-origin Python/JavaScript workers as code execution with origin capabilities, not a security sandbox.
- **Financial reporting is not a full invoice model.** Learn deliberately excludes cache-read input from usage_logs, and a single input rate cannot represent all cache-write/read pricing. Keeping learner quota discounts is legitimate, but the admin cost view needs separate billable usage fields if it is intended to reconcile to provider invoices.
- **Production configuration remains unverified.** Confirm applied migrations, actual grants and bucket settings, account/signup protections, Realtime/document-upload flags, provider budgets, deployment protection, log access and a tested restore. Files in the repo are not proof that these settings are deployed. The earlier profile self-promotion defect has a migration fix; that fix still needs to be present in the live database.

## Validation and limits

- Unit suite: **1,507 tests passed across 72 files**.
- TypeScript: **passed**, with no emitted files.
- ESLint: **passed**.
- Production dependency audit: **one moderate advisory**, detailed above. The first restricted-network attempt failed; the network-enabled retry succeeded.
- Production build: **passed**. The initial restricted-network build could not fetch Google Fonts; rerunning with network access completed successfully.
- Only .env.example is tracked among .env files. A targeted scan of tracked files found no matching common private-key, provider-secret or JWT patterns. This is not a complete secret-history or deployment-bundle audit.
- No authenticated two-tenant integration exercise, live database policy inspection, production load test or paid-provider test was performed. Existing green tests do not establish those security properties.

Several important controls are present: authenticated server-side identity lookup, server-only service credentials, private buckets, profile write lockdown, explicit administrative gates, usage logging deferred through after(), and CI checks. The findings above concern gaps between those controls, rather than their total absence.

## Recommended release order

1. Fix and prove the file-reference ownership boundary with two synthetic users.
2. Bound model inputs and repair atomic reservation lifetime/failure behavior; add TTS allowance enforcement.
3. Keep Realtime disabled until spend and lifecycle controls are server-owned.
4. Enforce account blocking and upload restrictions at both API and direct Supabase boundaries.
5. Update the vulnerable dependency and verify the deployed database/settings, then run the same abuse cases in a disposable staging environment.

This report is advisory only; no fixes or deployment changes were applied.
