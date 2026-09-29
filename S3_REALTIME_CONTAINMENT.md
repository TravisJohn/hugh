# S3: Realtime administrator preview containment

Prepared for production release on 2026-09-30. Deployment verification is recorded in the project log. No migration or provider configuration change is required.

## Release behavior

Realtime credential issuance now requires all of the following:

- `MASTERY_REALTIME_ENABLED` is exactly `true`.
- The request is authenticated.
- The protected database profile explicitly has `is_admin = true` and `is_blocked = false`.
- Existing usage and milestone-ownership checks pass.

The page and credential endpoint use the same access policy. Approved free and pro learners receive scripted mastery even when the Realtime flag is enabled. A direct request to the credential endpoint returns 403 before reserving quota, reading milestone content or calling OpenAI. Client-supplied account flags cannot grant access. A failed profile query returns 503 without issuing a credential; missing or incomplete privileges deny access.

Administrators can still use `?classic=1`. Disabling the feature flag closes new Realtime sessions for administrators too. The existing browser-usage endpoint remains available so sessions started before containment can submit their best-effort reports; accepting those reports does not validate their accuracy.

## What remains open

This contains the public credential-issuance path. It does not repair Realtime's underlying trust model: an administrator's browser still reports its own spend and enforces its own timer. Existing client-side limits and bounded usage reports are not server-enforced accounting.

Do not mark S3 fully resolved or re-enable Realtime for regular learners on the strength of this change. Administrator accounts are trusted preview users, not evidence that the current accounting is safe for public access. The feature flag still defaults to false.

The change does not revoke credentials already issued or terminate active calls. Before release, identify whether Realtime was publicly enabled, close any known active calls through supported provider controls, and verify their termination. This application has no durable call inventory today, so repository changes alone cannot prove that all earlier calls ended. Credential expiry and an existing call's end are different events. Keep usage reports enabled during the transition.

The administrator decision relies on protected profile data. Migration 032 removes authenticated writes to profiles; confirm the deployed database enforces that protection. No live database grants or production flag values were inspected for this change.

## Full public-access repair

Keep the existing `gpt-realtime-mini` model while designing the repair; this containment does not migrate models or APIs. OpenAI documents a server-side control connection for an existing Realtime WebRTC call using the provider call ID. That supports observing events and controlling the session from the backend. See the Realtime section of [OpenAI's server-side controls guide](https://developers.openai.com/api/docs/guides/voice-server-controls#with-webrtc).

The remaining application work is:

1. Establish calls through the server and bind a provider call ID to an authenticated user and durable session record. A browser-supplied ID must not determine ownership.
2. Acquire a durable per-session budget reservation and concurrency slot before starting billable work. Missing reports or process crashes must not restore spent budget.
3. Use a backend connection that survives the whole session to observe provider usage. Deduplicate provider events and reconcile a session once; browser totals become diagnostic information only.
4. Enforce deadlines, activity/output budgets and termination server-side. Prove the behavior with a modified client that ignores timers, changes session settings, disconnects, or omits reports. A sideband connection alone is not proof that clients cannot create extra spend.
5. Handle observer failure, startup failure, late events and incomplete finalization conservatively. Add a recovery worker and verify provider-supported termination for the deployed API. The current short-lived route/`after()` pattern is insufficient as a durable session owner.

This needs a persistence migration and a deployment decision for the long-lived session controller. Keep S4's reservation-expiry defect and S5's broader fallback behavior tracked separately.

## Validation and rollout

Thirty added tests exercise the pure access policy, the real credential route with mocked dependencies, and server-page rendering. They cover flag-off, unauthenticated access, free/pro learners, forged JSON flags, missing/blocked/invalid profiles, database errors, administrator admission, usage/ownership checks, classic fallback, and reports from pre-containment sessions. No real credentials were minted and no billable provider calls were made.

The combined development workspace passed 1,649 tests, lint and a production build. This release excludes the uncommitted S2 changes; its exact revision is verified independently by CI before merging.

After review and deployment, verify with a regular learner that scripted mastery loads and direct credential requests return 403 even when the flag is on. Verify an unblocked administrator can use the preview and `?classic=1`, then confirm flag-off prevents credential issuance. Verify the protected profile grants and active-call transition separately before considering public exposure contained in production.
