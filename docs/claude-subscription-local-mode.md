# Hugh on your Claude plan — local only

Status: **proposal, awaiting Travis's approval. No code written.**
Branch: `feat/claude-subscription-local` (own worktree; `main` untouched).
Checked against Anthropic's live docs on 2026-10-28.

---

## 1. Is it allowed?

**Yes, within narrow limits.** You can use your own Pro/Max plan, through the
*unmodified* `claude` binary, on your own machine, for your own requests.

What Anthropic's docs say
([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)):

- Allowed: the policy does not "prevent an end user from signing in to the
  unmodified Claude Code binary with their own Claude subscription."
- Plan limits "assume ordinary, individual usage of Claude Code and the
  Agent SDK." The Agent SDK's CLI form is `claude -p`
  ([headless docs](https://code.claude.com/docs/en/headless)).
- Not allowed: third-party developers may not "offer Claude.ai login into
  their own applications, or ... route requests through Free, Pro, or Max
  plan credentials on behalf of their users," nor "collect, store, or
  intermediate Claude.ai credentials or session tokens."
- [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) §2: "You
  also may not make your Account available to anyone else." §3 allows
  scripted access only "via an Anthropic API Key or where we otherwise
  explicitly permit it". Headless `claude -p` with a subscription login is
  explicitly documented, so it counts as permitted.

What that means for Hugh, as hard rules:

1. **Never deployed.** It must be impossible to run on Vercel or against a production build.
2. **Only you.** No other Hugh account can ever be served through your plan,
   even on your local server. Local dev talks to the production Supabase
   project, so any learner could sign in there.
3. **Hugh never touches the token.** The `claude` binary signs itself in and
   holds its own credential. Hugh does not read, store or pass a plan token.
   No `CLAUDE_CODE_OAUTH_TOKEN` goes in `.env.local`.
4. **Manual use only.** Exploring by hand is "ordinary, individual usage".
   Replays, evals and load tests stay on the API key. Anthropic says it "may
   enforce these restrictions ... without prior notice."

**Grey edge, stated plainly.** The same page says developers building products
"should use API key authentication". This proposal relies on the end-user
carve-out: you, as the end user, running the real binary. It does not rely on
any exception for Hugh as a product.

## 2. How hard is it?

**Medium, not hard.** The plumbing is small: one adapter, plus a one-line
change in each of the 19 places Hugh creates a Claude client. Two things make
it more than a toggle:

- **Silent paid billing.** `claude -p` *always* uses `ANTHROPIC_API_KEY` if
  that variable is in its environment. Hugh's server has it from `.env.local`.
  A naive version would quietly keep billing the key while looking like it
  works. The adapter must strip that variable and then prove which credential
  was used on every call.
- **learn/chat's JSON contract.** The API takes a multi-turn conversation.
  `claude -p` takes one prompt, so the conversation has to be written into a
  single prompt. The models are the same, so the contract *should* hold, but
  that has to be measured.

**Recommendation:** run the installed `claude` CLI headless from a local-only
adapter. Put it behind one `claudeClient()` factory, lock it to one user, and
make it refuse to start in production.

---

## 3. PRD

**Goal.** You can explore Hugh locally with every Claude call served by your
Claude plan instead of the paid API key. In that mode, paid Claude spend should
be impossible, not merely unlikely.

**User.** You alone, as one Supabase user id.

**In scope**
- All 19 places Hugh creates a Claude client (15 routes and 4 shared helpers),
  Haiku and Sonnet alike. Track builds that run in `after()` are included.
- A separate start command (`npm run dev:subscription`). Plain `npm run dev`
  stays exactly as it is today.
- Usage rows still record tokens, but at $0, labelled as served by the plan.
- Hitting the plan limit gets its own clear message. Hugh never falls back to
  the API key.
- Paid non-Claude features are **off** in this mode (see §4.2).

**Out of scope**
- Production, Vercel, preview deployments, and any other user.
- Streaming. Hugh streams nothing to the browser today.
- OpenAI and ElevenLabs on any subscription. The Codex ChatGPT-plan pilot is a separate track.
- Offline scripts (replay harness, probes). They stay on the API key on purpose.
- Restoring the parked provider seam (see §4.8).

**Success criteria**
1. A session of exploring adds **zero** usage in the Anthropic Console. You
   check this. Every call also proves `apiKeySource: "none"`, and any call
   that doesn't fails loudly.
2. learn/chat holds its JSON contract on the plan path, against a bar you
   approve (proposed: 19 of 20 sample conversations parse strictly, and 20 of
   20 are usable after the existing tolerant parser).
3. The mode refuses to start when `NODE_ENV=production`, `VERCEL` or
   `VERCEL_ENV` is set. A CI test pins this.
4. Any other Hugh account signed in to the local server is refused.
5. The CI gate is green and the API-key path is unchanged. Existing tests pass
   without edits.

---

## 4. Architecture

```
route ──► claudeClient() ──► [api mode]          Anthropic SDK ──► paid API   (unchanged)
                         └─► [subscription mode]  runClaudeCli ──► `claude -p` ──► your plan
```

| Module | Pure? | Job |
|---|---|---|
| `lib/claude/billingMode.ts` | yes, tested | One decision: `api` or `subscription`, made from the environment. Throws in production or on Vercel. Owns the `@subscription` rate-class label. |
| `lib/claude/subscription/cliArgs.ts` | yes, tested | Turns a `messages.create` request into `claude -p` arguments and a single prompt. |
| `lib/claude/subscription/parseResult.ts` | yes, tested | Turns CLI output into the SDK's `Message` shape, and into typed errors (limit reached, not signed in, billed to a key). |
| `lib/claude/subscription/runClaudeCli.ts` | no (I/O) | Starts the process with a cleaned environment, applies a timeout and a concurrency cap of 2, and collects the output. |
| `lib/claude/client.ts` | — | `claudeClient()` returns the real SDK client or the subscription client. Both have the same `messages.create` shape. |

### 4.1 Which routes go through the plan
All 19 Claude call sites, by changing `new Anthropic({ apiKey })` to
`claudeClient()`. Routes keep their `MODEL` constant, their prompts and their
parsers. The same model id (`claude-haiku-4-5`, `claude-sonnet-4-6`) is passed
with `--model`. The two offline operator scripts (`scripts/author-cases.mjs`,
`scripts/backfill-priority.mjs`) stay on the API key: they run outside the app.

How each call keeps behaving like the API version:
- **Settings and context.** `--system-prompt-file` replaces Claude Code's own
  prompt, and `--tools ""` turns off all tools. MCP servers, slash commands and
  session saving are also off. The call runs in an empty temporary folder
  against a dedicated config folder (`~/.claude-hugh`), which has no
  CLAUDE.md, no hooks and no plugins. Your real Claude Code setup never leaks
  into Hugh's prompts.
- **Output length.** `max_tokens` is passed through
  (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`).
- **Thinking** is pinned off to match today's API calls.
- **Prompt delivery.** The prompt goes in through stdin and the system prompt
  through a file, because Windows caps a command line at 32,767 characters.
- **Caching.** `cache_control` is dropped (Claude Code caches on its own). That
  doesn't matter at $0, but the adapter reports it rather than hiding it.

### 4.2 OpenAI and ElevenLabs
A Claude plan doesn't cover them. **Recommended: in subscription mode they are
switched off**, each with its own message: "Off while Hugh runs on your Claude
plan. Start with `npm run dev` to use it (paid)." The routes affected are Notes
Coach, Notes summarise, Realtime mastery voice, `/api/tts` and the admin
architecture assistant. That is what "no tokens burning" means. The
alternative, leaving them on the paid keys, is one flag away if you want it.

### 4.3 `logUsage` and the usage gate
- **Zero cost without a migration.** Add `claude-haiku-4-5@subscription` and
  `claude-sonnet-4-6@subscription` to `MODEL_RATES` at $0. `logUsage` adds the
  suffix in one place, from `billingMode`. This follows the existing precedent
  of `gpt-realtime-mini-text`, a rate class that only ever appears in
  `usage_logs.model`. Only Claude rows are relabelled: an OpenAI or voice row
  keeps its own id whatever the mode, because the plan never pays for it.
- **The project rules still hold.** Each route still names `MODEL` once. Every
  row is still priced at its own rate. Token counts stay honest, so the Usage
  view still shows what you used. No schema change, and nothing changes for
  production rows.
- **The gate is unchanged.** It still reserves budget and still applies 30
  requests a minute, which also stops a runaway loop from draining your plan.
  The owner lock lives in `checkUsageAllowed()`, the one function every
  spending route calls. `proxy.ts` deliberately skips `/api`, so it can't hold
  the lock.

### 4.4 Streaming and latency
Nothing in Hugh streams today; every route waits for the full reply. The
adapter therefore collects the CLI's event stream and returns one message. It
uses the event stream rather than plain JSON only because the stream carries
`apiKeySource`, the proof of which credential was used. **Each call is about
0.7 s slower**, because a process starts every time (measured in stage 1; a
short Haiku reply takes about 1.5 s end to end). Track builds run in `after()`
and aren't affected by the wait.

### 4.5 Plan limits
Hugh shares your plan's 5-hour and weekly limits with your Claude Code coding
sessions and claude.ai chats. The Sonnet routes use the most: track builds, the
quiz and mastery evaluation. When a limit is hit, the route returns 429 with
its own message (that the limit was reached, plus the reset time if the CLI
gives one) and says plainly that Hugh did not switch to paid usage. Hugh never
retries on the API key.

### 4.6 Turning it on, and why it can't ship
- `npm run subscription:login` opens the normal Claude sign-in for the
  dedicated config folder. You sign in yourself, once.
- `npm run dev:subscription` starts `next dev` bound to `127.0.0.1` with
  `HUGH_CLAUDE_SUBSCRIPTION=1`. Only this script sets the flag; it is never in
  `.env.local`.
- `HUGH_SUBSCRIPTION_OWNER_ID` in `.env.local` names the one account allowed.

Six independent stops on production:
1. The flag is set only by the script.
2. `billingMode` throws if `NODE_ENV=production`, `VERCEL` or `VERCEL_ENV` is
   set, so a build with the flag set fails.
3. The owner lock refuses every other user.
4. The dev server listens on localhost only.
5. No new npm dependency, and there's no `claude` binary on Vercel.
6. A CI test pins stops 2 and 3.

### 4.7 Checking the JSON contract
learn/chat's conversation is written into one prompt with clear turn markers,
ending "reply to the final learner message." A local check runs 20 sample
conversations (fixtures, not real learner data) through the plan path. It
reports the strict-parse rate and how often the tolerant parser had to rescue
a reply. Quiz, evaluation and track generation each get one sample too. This
uses your plan allowance, not dollars.

### 4.8 Earlier work
- **Parked seam (`parked/llm-provider-seam`): not restored.** Its core rule is
  "the model id picks the provider", but here the model is the same either way;
  only who pays changes. Restoring it means merging 1,412 lines and rewriting
  all 20 call sites onto `complete()`. This plan needs one factory and 19
  one-line changes. Two of its ideas carry over: dropped hints are reported,
  and stop reasons are passed through as-is.
- **Codex `codex/chatgpt-plan-prep`.** That branch is a ChatGPT-plan pilot for
  Notes summary, blocked on OpenAI commercial access. No code reused. Three of
  its rules are adopted: the switch is off unless the server turns it on, each
  usage row records who paid, and a plan failure never silently falls back to
  paid usage.

---

## 5. Risks

| Risk | Handling |
|---|---|
| Exploring writes real rows to **production** Supabase | **Recommended:** make the owner your *test learner* account, which `scripts/seed-test-user.mjs --reset` can wipe, not your real account. |
| Quiet billing to the API key | The process gets only the variables it needs (an allow-list), so no keys from `.env.local` reach it. Every call must report `apiKeySource: "none"` or it fails. |
| Your Claude Code setup leaks into prompts | Dedicated config folder, empty working folder, and `--system-prompt-file` plus `--tools ""`. |
| The plan won't serve the older model ids (`claude-sonnet-4-6`, `claude-haiku-4-5`) | Stage 1 probe. If refused, I stop and bring it back to you; no silent model swap. |
| Behaviour differs from the API (thinking, length) | Thinking pinned off and `max_tokens` passed through, both checked in the probe. |
| Plan limits shared with your coding | Stated in §4.5; the 30-a-minute gate stays. |

## 6. Build plan (only after approval; summary and your OK between stages)

1. **Probe and decision module.** `billingMode.ts` with tests. You sign in once
   to `~/.claude-hugh`; I run one Haiku and one Sonnet call to confirm the
   credential, the model ids, thinking-off and the output shape.
2. **Adapter.** `cliArgs`, `parseResult` and `runClaudeCli`, with tests run
   against recorded CLI output.
3. **Wiring.** `claudeClient()`, the 19 one-line changes, the `@subscription`
   rate classes and the `logUsage` suffix.
4. **Guards.** Owner lock, paid-provider off-switch, and the limit and sign-in
   error messages.
5. **Scripts.** `dev:subscription`, `subscription:login`, `.env.example`, and
   the CI test that pins the production stop.
6. **Checks.** JSON contract check, the full gate (lint, tsc, test, build), a
   `PROJECT_LOG.md` entry, and a browser checklist for you to run.

## 7. Decisions (approved 2026-10-28)
- **Approach:** CLI adapter with `claudeClient()`; the parked seam is not restored.
- **OpenAI and ElevenLabs:** off in subscription mode.
- **Owner:** your test learner account.
- **Contract bar:** 19 of 20 strict and 20 of 20 usable.

## 8. Stage 1 probe findings (2026-10-28, Claude Code 2.1.283)

One call each, on the Hugh-only login (`authMethod: claude.ai`, Pro plan):

| | Haiku 4.5 | Sonnet 4.6 |
|---|---|---|
| `apiKeySource` | `none` (served by the plan) | `none` |
| Model id accepted as-is | yes | yes |
| Thinking tokens | 0 | 0 |
| Model time / wall-clock time | 0.8 s / 1.5 s | 1.2 s / 1.9 s |

- **Start-up overhead is about 0.7 s per call.**
- **The CLI reports plan limits.** It emits a `rate_limit_event` containing
  `status`, `resetsAt`, the use of the 5-hour and 7-day windows, and
  `overageStatus` / `isUsingOverage`. The adapter will treat
  `isUsingOverage: true` as limit-reached, so Hugh never runs up paid extra
  usage on the plan.
- **About 350 input tokens per call are Claude Code's context, not Hugh's.**
  `--exclude-dynamic-system-prompt-sections` doesn't apply when
  `--system-prompt-file` is set. Settled in §9.
- **Open for stage 6:** Haiku wrapped its JSON in a ```` ```json ```` fence;
  Sonnet didn't.

## 9. Stage 2 adapter findings (2026-10-28, Claude Code 2.1.283)

The adapter is three modules plus a typed error, with 38 tests. Two of the
modules (`cliArgs`, `parseResult`) are pure and tested against real recorded
CLI runs. The third, `runClaudeCli`, is tested against a stand-in process that
replays those recordings, plus one real Haiku call: a three-turn conversation
that answered the final turn in 1.5 s, served by the plan.

- **The extra ~350 tokens can't be removed, and they're accepted.** Claude Code
  adds five short notes to every prompt: the machine's environment, which
  model is answering, its output budget, the signed-in account's email, and
  today's date. The only switch that drops them (`--bare`) also drops the plan
  sign-in. On the plan they cost limit headroom, not money; the real call
  measured 432 input tokens for a request of about 60. The email goes only to
  Anthropic, which already holds it. Whether the notes change Hugh's answers
  is measured in the stage 6 contract check.
- **The CLI doesn't stop at the output cap; the adapter does.** When a reply
  reaches `max_tokens`, Claude Code silently asks the model to carry on, about
  four times, and then reports an error. Each carry-on re-sends the whole
  prompt against your limits. The runner stops the process at the first
  carry-on and returns the cut-off first reply with `stop_reason:
  "max_tokens"`, which is what the API returns.
- **Retries match the API path.** Claude Code retries a failed request 10
  times by default. The adapter passes the caller's count instead: 0 from the
  usage gate (so one admitted call is one request), otherwise the SDK's 2. The
  setting is pinned by a test; it hasn't been seen against a real failing
  request, because there's no safe way to cause one.
- **A failure is never read as an answer.** Claude Code labels a failed run
  `subtype: "success"` with `is_error: true`. The adapter goes by `is_error`
  and the error category, and each failure has its own reason: billed to a
  key, signed out, limit reached (with the reset time when given), model
  unavailable, timed out, or failed. Stage 4 turns each into its own message.
- **The key tripwire acts before any request is sent.** The start-up event
  names the credential before the request goes out, and the runner kills the
  process there. In the test the process was stopped in under 3 s.
- **A wrong login folder looks exactly like "signed out".** During testing a
  mistyped path to `~/.claude-hugh` produced "Not logged in". Stage 3 builds
  the path from the home folder rather than typing it, and stage 4's sign-in
  message names the folder it looked in.
- **Windows.** The native installer's `claude.exe` is found without a shell.
  An npm-installed `claude.cmd` would not be; stage 5's login script checks
  which one is on the path.
- **Smaller notes.** `NODE_ENV` is deliberately not passed to the CLI. Replies
  carry the dated model id (`claude-haiku-4-5-20251001`); usage rows keep
  using each route's own `MODEL`, so nothing changes there. The concurrency cap
  of 2 queues extra calls rather than refusing them.

## 10. Stage 3 wiring notes (2026-10-28)

- **One factory, 19 sites.** Eighteen sites changed one import and one line;
  `generateMilestones` keeps its build-on-first-use client, now built by
  `claudeClient()`. The only `new Anthropic(...)` left in the app is inside the
  factory, and on the API it builds the same client as before.
- **The compiler checks the plan path's limits.** `claudeClient()` returns a
  client whose `create` takes only a `TextCall` (text in, text out). The real
  SDK client fits that type unchanged, and every current call site compiles
  against it. A future call that adds tools, images or streaming fails the type
  check instead of misbehaving on the plan.
- **Usage rows.** `logUsage` adds `@subscription` to Claude rows in plan mode,
  priced at $0 in `lib/pricing.ts`. A test fails if a Claude model is ever
  priced without its plan twin.
- **Caching hint.** learn/chat's `cache_control` has no effect on the plan
  path; the server says so once per run instead of on every turn.
- **Not yet in place (stage 4):** the owner lock, the paid-provider switch-off,
  and the learner-facing messages for limit reached and signed out. Until then
  plan mode must not be started.
