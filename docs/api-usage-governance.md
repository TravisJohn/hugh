# API usage and paid access map

Updated 2026-10-02. This describes the pending scripted-mastery removal branch,
not the currently deployed application.

## Current request paths

| Surface | Provider and route family | Who pays today | Current control |
| --- | --- | --- | --- |
| Topic selection, track generation, document extraction, milestones | Anthropic via `dashboard/*`, `tracker/*`, and `lib/tracker/*` | Hugh's Anthropic API account | Auth/approval, shared reservation and 30 requests/minute per user; free monthly token cap |
| Ask Hugh, diary verification, review quiz, code chat/drill, cloud chat | Anthropic via `learn/*`, `tracker/review/*`, `code/*`, `cloud/*` | Hugh's Anthropic API account | Auth/approval and shared reservation/rate gate |
| Notes Coach and Notes summary | OpenAI Chat Completions via `notes/coach`, `notes/summarize` | Hugh's OpenAI API account | Auth/approval, shared reservation/rate gate, usage logs |
| Live mastery voice | OpenAI Realtime via `tracker/mastery/realtime-session`; browser connects to OpenAI; recap uses Anthropic | Hugh's OpenAI and Anthropic API accounts | Server verified administrator and feature flag at credential mint; browser reported voice usage, so learner access remains closed |
| Admin architecture assistant | OpenAI via `architecture/chat` and local dashboard assistant | Hugh's OpenAI API account | Administrator access; this operator tool is outside learner `logUsage` and needs its own cost review |
| Prerecorded code drill audio | Local MP3 files | No runtime API charge | Static playback |
| Retired scripted mastery and ElevenLabs TTS | No active route in this branch | No new runtime charge | Historical `tts_chars` logs and pricing retained for past reporting |

The current token policy enforces the monthly cap for free accounts. Pro and
administrator accounts have a display allowance but no enforced monthly token
ceiling. The shared 30 requests/minute gate applies to every plan. These are
per-user controls, not a hard organization-wide spending limit. See
`lib/tokenBudget.ts` and `lib/usage.ts`.

## Paid-only Live voice

Hugh's `profiles.plan = "pro"` is the product entitlement. It is separate
from whether a learner has ChatGPT Plus or Pro. The Mastered-column UI already
checks Hugh Pro, but the Realtime credential endpoint intentionally accepts
only an unblocked administrator. A browser-only plan check would not protect
the provider key.

Before opening Live voice to paying learners:

1. Make the server own each provider call's identity, usage, deadline,
   termination, and recovery. Keep a durable per-session reservation and
   concurrency slot.
2. Define a per-Pro-user voice allowance and a workspace-wide ceiling.
   Refuse a new session before minting a credential when either is exhausted.
3. Check the protected plan on the server at credential issuance and use the
   same policy on the page. Test direct requests and forged client claims.
4. Decide product semantics: the current Live flow writes a recap but does not
   score or set `mastery_validated`. The retired scripted flow did.

`S3_REALTIME_CONTAINMENT.md` details the remaining server-owned accounting
and lifecycle work. A paid gate by itself would leave the cost risk open.

## ChatGPT plan usage feasibility

Official OpenAI documentation says eligible users may authorize their own
ChatGPT plan for eligible Responses API requests. The published self-service
flow is for open-source and locally hosted applications. OpenAI directs paid
or remotely hosted applications to its interest form, and says commercial
partner access is a limited trial. Hugh is a remotely hosted paid product, so
access must be confirmed before implementing this as a billing path.

The documented plan-usage endpoint is `POST /v1/responses` with the user's
OAuth token. Hugh's Notes currently uses Chat Completions; Live voice uses
Realtime. Neither route is established as eligible by that documented
Responses contract. Anthropic requests cannot use a ChatGPT plan. Each
learner would authorize their own plan; the founder's plan is not a shared
Hugh API budget.

If OpenAI grants Hugh access, pilot one bounded text feature through Responses
under a separate user consent and usage path. Keep Hugh Pro entitlement,
OpenAI authorization, and provider cost accounting as three distinct states.
Do not move Live voice until OpenAI confirms a supported plan-usage voice
contract and Hugh's server-owned session controls are complete.

Official references:

- https://developers.openai.com/siwc/quickstart
- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
