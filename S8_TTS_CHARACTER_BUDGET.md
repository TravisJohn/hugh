# S8: monthly TTS character allowance

TTS uses ElevenLabs characters, not model tokens. The shared `reserve_usage`
gate continues to enforce the 30-request/minute rate limit with a zero-token
claim. Migration 057 adds a separate atomic monthly character counter. On the
first request in a period it seeds earlier TTS usage from `usage_logs`; later
requests lock the counter and compare admitted characters with the cap.

The proposed caps are 20,000 characters for free accounts and 100,000 for
pro/admin accounts. With the existing cost estimate in `lib/pricing.ts`, those
correspond to about US$6 and US$30 respectively. These are per-account caps,
not a workspace-wide financial ceiling. An admin usage reset begins a new
period for both token and TTS admission.

Each granted request is charged before the ElevenLabs call and never refunded.
A stream can fail after the provider has billed it, so retaining the charge is
the safe bound. `usage_logs` still records completed audio generation for the
cost view. A failed provider call may therefore consume some of the learner's
allowance without appearing as completed usage; that trade-off should be clear
in the UI if a voice-usage display is added later. Malformed input, unknown
personas and a missing provider key are refused before either gate consumes a
slot or characters.

## Validation

Disposable PostgreSQL tests cover seeding earlier usage, exact-limit refusal,
a fresh monthly period, server-only RPC permission, and eight concurrent
near-limit requests (one admission). Unit tests cover every plan, unavailable
RPC refusal, and the route's provider-call boundary. No provider calls or
production usage counters are involved in these tests.

## Rollout order

1. Review the release PR and finalize the cap choice. Pause TTS and let
   in-flight requests finish, then apply `supabase/migrations/057_tts_character_budget.sql`
   once in the Sydney Supabase SQL editor. It is transactional and forward-only.
2. Merge the application gate only after confirming `reserve_tts` exists.
   Deploying code first deliberately returns 503 for TTS until the migration
   is present.
3. Verify a synthetic user's current-period admission and exact cap without
   calling ElevenLabs. Confirm the normal TTS route still works with a small
   request, then check that an exhausted test account gets 429 before a provider
   call. Do not use a real learner's billing period for the boundary exercise.
4. Configure a credit quota on Hugh's ElevenLabs API key as an independent
   workspace-wide backstop. Per-account caps cannot prevent many newly approved
   accounts from exhausting one shared provider pool.
