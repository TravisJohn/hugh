# ChatGPT plan usage in Hugh: feasibility as of 1 October 2026

## Availability

OpenAI's [Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart)
says eligible Plus and Pro users can authorize participating apps to use their
ChatGPT plan for eligible AI requests. The open-source flow is available to
open-source partners, while commercial integration is a limited trial. The
[OpenAI cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
specifically directs paid or remotely hosted apps to request access through
its waitlist before offering plan usage. Hugh is a remotely hosted Vercel app,
so eligibility must be confirmed before implementing a production connection.

Sign-in identity and plan usage are separate permissions. A learner would need
to consent to plan usage; a successful login alone cannot fund requests. Usage
counts toward that learner's existing plan limits and can be capped per app in
ChatGPT settings. See the [user guide](https://learn.chatgpt.com/docs/sign-in-with-chatgpt).

## Fit with Hugh's current AI routes

The documented plan-usage inference path uses a user-authorized OAuth token on
the [Responses API](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
with streaming enabled and storage disabled. Its
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
exclude several request fields and other OpenAI endpoints.

- Hugh's Learn, Code, Cloud and most track generation routes use Anthropic.
  ChatGPT plan usage would require a deliberate model and prompt migration for
  any of these features; it would not pay Anthropic requests.
- Notes Coach, Notes summarization and the architecture assistant currently
  use OpenAI Chat Completions. They would need a Responses API adaptation and
  account-specific model selection before using this authorization flow.
- Realtime mastery uses the Realtime API, outside this documented Responses
  path. ElevenLabs TTS is a separate provider and remains a separate cost.
- Hugh's own Supabase session, approval, blocking and usage records remain
  authoritative. Connecting ChatGPT must not grant Hugh access to conversations
  or bypass Hugh's existing access checks.

## Next decision

Decide whether this is for the founder's private testing or for every eligible
learner to connect their own account. Request hosted-app access from OpenAI
before promising plan usage in Hugh. Once access is granted, prototype one
low-risk OpenAI text route with explicit consent, token storage and refresh,
plan-limit failure handling, and Hugh's existing usage accounting. Keep the
current provider path until that prototype has been verified.
