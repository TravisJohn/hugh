# S2: bounded text requests and prompt-sized reservations

Implemented on 2026-09-29 and validated for release on 2026-09-30. Deployment verification is tracked in the security review. No new migration is required; the existing `reserve_usage` function from migration 049 accepts the computed estimate.

## What changes

The seven reviewed routes (Learn, Code and Cloud chat, Learn summary, dashboard refinement and goal creation, and scripted mastery) validate incoming JSON at runtime before reserving or calling a model. The reader stops at the actual byte limit, even with a missing or dishonest Content-Length header. Invalid shapes return 400; excessive sizes return 413 with actionable text.

| Input | Limit |
|---|---:|
| Raw request | 192 KiB |
| Each message | 16 KiB of UTF-8 text |
| Combined message text | 64 KiB |
| Learn chat / Code and Cloud chat | 20 / 12 messages |
| Full summary / scripted mastery | 100 / 6 messages |
| Topic | 1,600 bytes; goal/refinement also retain the existing 200-character topic rule |
| Code context | 8 KiB |
| Refinement | Five answers, 4 KiB each; questions 2 KiB each |
| Assembled model prompt, including system text and stored context | 128 KiB |
| Mastery note count | 64; a 65th note causes an explicit refusal |

The chat clients retain the full displayed conversation but send a bounded recent window of whole messages. Oversized or refused chat drafts remain editable. Refinement validates before clearing the answer draft. Summaries and mastery transcripts are not silently shortened. Mastery now includes full note bodies instead of slicing every note to 2,000 characters; an oversized note set is refused explicitly.

## Reservation and retry behavior

For these text-only calls, the admission allowance is:

`attempts * (UTF-8 bytes of system and messages + 1,024 framing allowance + 64 per message + maximum output tokens)`

This is a deliberately conservative allowance, not an exact token count or invoice estimate. It assumes ordinary text on the current Claude models; it is not suitable for images, tools, documents, thinking or streaming. Cache reads do not reduce admission. Actual usage logging continues to drive recorded consumption.

The exact assembled prompt is passed to both the guard and the provider. SDK automatic retries are disabled on guarded calls. Refinement reserves each explicit attempt separately. Goal classification and milestone generation reserve both possible attempts before their loops. Goal refinement, classification, background generation and optional backlog ranking each acquire their own prompt-sized reservation. Each acquisition also consumes one existing rate-limit slot; a goal can therefore consume several slots.

Goal creation retains `pending -> after() -> ready | failed`. A background generation denial marks the goal failed; an optional ranking denial retains the usable unranked board. A classification budget denial cannot enter the classifier's fail-open error path.

If the atomic RPC fails, prompt-sized calls return 503 and do not reach the model, including pro/admin calls. Other routes keep their previous behavior; the wider S5 fallback finding remains open. Invalid and oversized requests make no provider calls.

Because reservations are conservative and remain counted alongside actual spend until expiry, users close to their monthly cap can be refused earlier than their displayed consumption suggests. This is admission headroom, not a larger permanent usage charge. S4's shared expiry window still needs a separate repair; S2 is not a claim that all quota bypasses are closed.

## Validation and release

- Full unit/integration suite on the S3/S9 release baseline: 1,649 tests across 80 files passed. ESLint, TypeScript, the production dependency audit and the final production build passed on 2026-09-30.
- Pure tests cover runtime types, boundaries, Unicode, representative code, complete summary/mastery transcripts and reservation arithmetic.
- Mock-provider route tests cover all seven endpoints, quota refusals, explicit retries, server-added context and the background goal state transitions.
- Usage integration tests verify the computed estimate reaches `reserve_usage`, preserves account/rate controls, and refuses RPC failures.
- An isolated PostgreSQL test runs eight concurrent reservations against a near-limit synthetic account; exactly one succeeds. CI runs it after the existing storage tests. It requires a disposable database named `hugh_s2_security_test` and uses no production credentials.
- Production database data and billable provider APIs were not used for validation. An authenticated browser smoke test remains part of release verification.

Before marking S2 deployed, review and merge this change, verify CI, and smoke-test a normal conversation, an oversized pasted message with an editable retained draft, a session summary, the refinement flow, and a scripted mastery session. Confirm production has migration 049 (already required by the existing quota gate). Keep S3-S9 tracked separately.
