# CLAUDE.md — Hugh

## What is Hugh?
Hugh is an AI-powered **learning platform** for data and analytics. A learner
picks a topic, Hugh generates a track of milestone cards, and the learner works
through them — asking questions, keeping a learning diary, proving mastery out
loud, drilling code, and working business cases. Named after the first person who
interviewed the founder.

It began as a mock-interview trainer. That loop was deleted on 2026-08-24
along with the standalone `/tracker` board — both were legacy, and the second
had become the unhardened path into track generation. **The learning loop is
the product.** Its voice (`/api/tts`, `lib/personas.ts`, `useAudioPlayer`,
`useSpeechRecognition`) was never interview-only and survives in `/mastery`.

`/learn` — a second, standalone "Focused Learning" chat with its own topic
picker — was deleted on 2026-08-31 for the same reason. Nothing in the app
linked to it (the `/home` grid points at `/home/learn`), so it was reachable
only by typing the URL, and a session saved from it created a `tracks` row with
no `goal_id` — which the board page can never find, because it looks a track up
BY its goal. Do not reintroduce a chat surface outside `/study/[goalId]/ask`.
`components/learn/` survives; it is what that page is built from.

### The surfaces
| Route | What it is |
|---|---|
| `/home` | Activity grid — the logged-in landing page |
| `/home/learn` → `/study/[goalId]` | Pick a topic, then the goal's Kanban track |
| `/study/[goalId]/ask` | Ask Hugh — tutor chat, diary, focus timer |
| `/review/[milestoneId]` | Diary-grounded review quiz |
| `/mastery/[milestoneId]` | Prove mastery out loud (scripted, or Realtime voice behind a flag) |
| `/code/start` · `/code/drill` · `/code` | Pattern map, timed fluency drills, free-form Python sandbox |
| `/cases` · `/cases/lab` | The Case Room (judgment cases) · Case Lab (long-form + CSV) |
| `/cloud` | Cloud-services reference — assistant, margin notes, and a review list |
| `/notes` | Screenshot + reasoning workspace with per-image Coach threads |
| `/monitor` | Monitor — hand-kept tracking: Skills · Job Applications (résumés/cover letters + applications) · Your Usage |
| `/admin` | Admin console — users, approvals, usage and cost |

The public landing page (`/`) presents three pillars — **Learn**, **Apply**
(code), **Show** (cases). All three are live; keep that page honest when a
pillar's scope changes.

## Tech Stack
| Layer | Tool |
|---|---|
| Frontend + Backend | Next.js 16 (App Router, Turbopack), React 19, deployed on Vercel |
| Database + Auth + Storage | Supabase (PostgreSQL + Supabase Auth) |
| LLM — Anthropic | Claude API (model per route — see Model Selection below) |
| LLM — OpenAI | Notes Coach (vision), Notes summarise, Realtime mastery voice, admin architecture assistant |
| TTS | ElevenLabs API |
| STT | Web Speech API (Chrome/Edge only) — a browser API, **not on-device**: Chrome sends the audio to Google. Realtime mastery uses OpenAI's transcription instead |
| In-browser Python | Pyodide (`lib/code/pyodide.worker.ts`) — code drills and sandbox |
| In-browser SQL | DuckDB-WASM (`lib/code/duckdbClient.ts`) |
| Editor | CodeMirror (`@uiw/react-codemirror`) |
| Styling | Tailwind CSS v4 |

Route gating and session refresh live in **`proxy.ts`** — Next 16's rename of
`middleware.ts`. There is no `middleware.ts`; don't add one.

## Model Selection
Pick the model per route by the job, not a blanket default — input tokens are the
bulk of Claude spend, so cheap routes should use the cheap model:

- **`claude-sonnet-4-6`** ($3/$15 per MTok) — reasoning-heavy generation where
  quality matters: track generation, backlog priority, quiz generation, diary
  fact-check, learn/summarize, mastery **evaluate** (scoring), document topic
  extraction.
- **`claude-haiku-4-5`** ($1/$5 per MTok — 5× cheaper input) — classification and
  short, low-stakes generation: similarity checks, hints, 5-whys refinement
  questions, mastery **open**/**respond** (in-character conversational lines),
  learn/chat, cloud/chat, code/chat, the topic-domain gate.
- **OpenAI** — `gpt-4o` where vision is needed (Notes Coach reads screenshots);
  `gpt-4o-mini` where it isn't (Notes summarise).

When in doubt, default to Sonnet. Only move a route to Haiku after confirming the
output quality holds.

### Every route names its model once
A route must declare `const MODEL = "…"` (or bind a local, where the model varies
by phase) and use that **one** binding for both the API call and the usage log.
Never repeat the model string — the two must not be able to drift apart.

## Usage and cost accounting
Every route that spends tokens **must** call `logUsage` with its `model`. A route
that calls `enforceUsageGate` but never logs is a bug: it checks the learner's
budget and then spends against it invisibly.

- Rates live in `lib/pricing.ts` — pure and unit-tested. `lib/usage.ts` re-exports
  them for the existing importers.
- Cost is computed **per log row**, at that row's own model rate, and then summed.
  Never apply one blended rate to an aggregate: Hugh's models differ by up to 20×,
  so aggregate-then-price silently mis-states spend.
- Adding a model means adding it to `MODEL_RATES`. An unknown model falls back to
  the most expensive Claude rate, so unknown spend is over-stated, never hidden,
  and `logUsage` warns in dev.
- Retry loops accumulate tokens across attempts — a discarded attempt still costs
  money and must still be logged.

**`learner_notes` is not the `/notes` workspace.** The margin (`lib/margin/`,
`components/margin/`, migration 045) is a plain textarea that saves — one note
per learner per thing-being-read, no images, no threads, no AI. `/notes` is
screenshot-first: a `notes` row has no body column at all, and every thread
hangs off an uploaded image read by a vision model. They answer different
questions and neither can carry the other's data model.

The margin is keyed `(surface, ref_id)`, not `(provider, service_id)` — Cloud
Skills is the first surface to have one, not the only one that should. Each row
snapshots its own `ref_label` and `ref_href`, refreshed on every save, so the
review list never needs a per-surface resolver to render a note. Adding a
surface means adding it to `MARGIN_SURFACES` in `types/margin.ts`; it is not a
migration. **The margin spends no tokens** — Cloud Skills browsing is a
zero-runtime-AI surface and the pad must not be what changes that.

**`activity_events` is not `usage_logs`.** Monitor's Usage view reads a separate
table that records *that a surface was used*, one row per learner per surface per
day. Do not merge the two. `usage_logs` records token spend, and three surfaces
spend nothing — Cases and Case Lab are static JSON, code drills run in Pyodide —
so their calendars would be permanently blank on `usage_logs` alone. Adding page
views to `usage_logs` would also corrupt the per-row per-model cost maths. The
two also speak different vocabularies: `usage_logs.feature` is route-level
(`learn/chat`), `activity_events.feature` is surface-level (`ask`).

## Environment Variables
All secrets live in `.env.local` (never committed). See `.env.example` for the
full list with notes on what each one gates.

- `NEXT_PUBLIC_` prefix → safe for client-side use
- All other keys → server-side only: read them from `/app/api/**` route handlers,
  Server Components, or `lib/**` modules marked `import "server-only"`

```
ANTHROPIC_API_KEY               # required
ELEVENLABS_API_KEY              # required
ELEVENLABS_VOICE_ID_1/2/3       # required
NEXT_PUBLIC_SUPABASE_URL        # required, public by design
NEXT_PUBLIC_SUPABASE_ANON_KEY   # required, public by design
SUPABASE_SERVICE_ROLE_KEY       # required, bypasses RLS — never expose
OPENAI_API_KEY                  # optional — gates Notes Coach, Realtime mastery
OPENAI_MODEL                    # optional — admin architecture assistant
HUGH_ADMIN_URL                  # optional — admin architecture assistant
MASTERY_REALTIME_ENABLED        # optional flag — Realtime voice mastery
SUPABASE_ACCESS_TOKEN           # optional — only for scripts/run-migration.ts
```

## Folder Structure
```
app/                        # Pages and API routes only — no business logic here
  api/                      # admin · architecture · auth · cases · cloud · code
                            # dashboard · learn · notes · tracker · tts
  (auth)/                   # login, signup
  home/                     # activity grid + /home/learn topic picker
  study/[goalId]/           # track board, ask page
  review/ · mastery/        # milestone review quiz, prove-mastery
  code/ · cases/ · cloud/ · notes/ · admin/
  monitor/                  # Monitor — Skills · Applications · Usage (tabs, ?view=)
components/                 # one folder per surface, plus ui/ primitives
lib/
  supabase/                 # client.ts (browser), server.ts (routes), service.ts
  claude/                   # prompts and parsers
  calendar.ts               # calendar-heatmap bucketing (pure, tested, shared)
  pricing.ts                # per-model rates (pure, tested)
  usage.ts                  # logging, quota gates (server-only)
  margin/                   # the margin: pure rules (tested) + server read
  tracker/ · learn/ · code/ · cases/ · case-lab/ · cloud/ · notes/ ·
  mastery/ · documents/ · askcode/ · pomodoro/ · architecture/ · monitor/
hooks/                      # useInterview, useNotes, usePomodoro, …
types/                      # Shared TypeScript interfaces
utils/                      # Pure helpers
supabase/migrations/        # Numbered SQL migration files
tools/architecture-dashboard/  # Local admin dashboard (built by predev/prebuild)
public/personas/            # Persona avatar images
```

## Architecture Rules — Read These First

### 1. Never call external APIs from the client
Anthropic, OpenAI, and ElevenLabs are server-side only. All calls go through
`/app/api/**` routes. The browser never sees these API keys.

### 2. One source of truth for session state
A screen's hook owns its state; components receive state and handlers via props
and do not fetch independently. `useNotes` / `useNotesLayout` own the Notes
workspace; `useTrackStatusWatch` owns "is this track built yet".

### 3. One track-build state machine
A track is built in exactly one shape, whatever started it:
```
pending → after() runs generateTrack → ready | failed
```
Watched by `useTrackStatusWatch` (Realtime + 3s poll + hard timeout). Three
routes drive it — `dashboard/goals`, `goals/document/approve`, and
`goals/[id]/retry` — and each must set `maxDuration`, gate usage, and settle
the status in both the success and failure branch. Do not add a fourth path
that generates a track synchronously; that was `/api/tracker/generate`, and it
was deleted for having no `maxDuration`, no usage gate and no domain gate.

Whether a build is *still running* or *dead* is decided in one place:
`lib/tracker/buildState.ts` (pure, unit-tested). The card, the track page and
the retry route all read it, so the Rebuild button appears exactly where the
server would accept it. Never re-derive that rule inline.

### 4. No scroll on any screen
Every screen must fit within the viewport height. Use `h-screen`, flex column
layouts, and `min-h-0` on flex children to prevent overflow. If content risks
overflowing, reduce padding or font sizes — never add scroll.

**Exception — the two records tools, `/notes` and `/monitor`.** Both are
document-style tools rather than teaching surfaces: they hold a growing pile of
the learner's own material, so their panes scroll *internally* while the page
itself stays locked to the viewport (`h-screen`, no page scroll). Notes has three
panes (tree · screenshots · thread); Monitor has two per view. Six skills fit a
screen, but forty job applications and half a year of diary entries do not.

These are the only two screens permitted to scroll inside their panes, and the
exception is drawn at *records tools*, not at "screens with a lot on them". A
teaching surface that outgrows the viewport should lose padding or gain
pagination — never a scrollbar.

Those panes are also user-resizable and individually collapsible. The geometry
lives in `lib/notes/layout.ts` (pure, unit-tested) and is driven by
`useNotesLayout`; a collapsed pane becomes a clickable rail, never nothing. Pane
components take their width from the workspace wrapper — they must not set their
own widths.

The public landing page (`/`) is marketing, not an app screen, and scrolls
normally.

### 5. A failure must be distinguishable from a wait
No surface may show one message for "still working" and "broken". If a state
can end in failure, the failure needs its own copy and its own way out — a
retry that reuses the existing machine, not advice to refresh or to delete and
start over. Reads that fail are the same rule: never render a dropped query
error as empty data, because "you have nothing" and "we could not load it" are
different sentences to the person reading them.

### 6. TypeScript strict mode — no `any`
All components, hooks, API handlers, and utility functions are fully typed. The
codebase currently has zero `any` and zero `@ts-ignore` — keep it that way.

### 7. Pure logic goes in a testable module
Anything with real branching — layout geometry, scoring, parsing, pricing, heat —
belongs in a pure `lib/**` module with unit tests beside it, not inline in a
component or a route that imports `server-only`. See `lib/notes/layout.ts`,
`lib/code/heat.ts`, `lib/pricing.ts`.

## Supabase Conventions
- `lib/supabase/client.ts` in client components (`createBrowserClient`)
- `lib/supabase/server.ts` in API routes and server components (`createServerClient`)
- `lib/supabase/service.ts` for service-role work that must bypass RLS
- All schema changes go in `supabase/migrations/` as numbered SQL files
- Migrations are **forward-only** — there is no rollback tooling. Apply them via
  the Supabase Dashboard SQL editor, or `scripts/run-migration.ts` with
  `SUPABASE_ACCESS_TOKEN` set. Applying is a manual step: shipping code that
  depends on an unapplied migration will break at runtime.
- Row Level Security must be enabled on all tables
- **Retention:** what a learner made (including `goal_answers`) is kept until
  they delete it. Only temporary or system records expire, by pg_cron jobs in
  migration 052. The windows live in `lib/retention.ts`, which `/privacy` renders
  and a test holds equal to the SQL — adding an expiry means changing both.

## Persona Configuration
Personas are a static config (not in DB), now used by scripted mastery for its
TTS voice. Three personas in `lib/personas.ts`, each with `id`, `name`, `role`,
`company`, `voiceId` (maps to `ELEVENLABS_VOICE_ID_1/2/3`), `avatar`. One is
picked at random per mastery session.

## Key Design Decisions
| Decision | Choice | Reason |
|---|---|---|
| Topic scope | Data/analytics only, LLM-judged gate at every entry point | Keeps tracks coherent; broader scope is a separate product |
| What Learn teaches | Concepts, not product surface. A topic naming a tool is accepted, and Hugh says up front it will teach the thinking behind it | Hugh teaches by conversation and cannot give hands-on practice. A track on which button to press dates on the next release and disappoints someone who came to learn the tool |
| Similarity check | LLM-judged (Claude), not string match | Handles paraphrasing correctly |
| Similarity threshold | >90% alignment = "used best answer" | Generous but meaningful |
| Review quizzes | Must quote verified diary lines | A quiz on untaught material is noise |
| Cases | Static JSON, zero runtime AI | Fast, cheap, portable; AI is used to author them offline |
| Cost accounting | Per-row, per-model | Models differ by up to 20×; one blended rate mis-states spend |

## DO NOT Build (deferred)
- Voice analysis: filler words, speech pace, volume, confidence scoring
- Mobile responsive layout
- AssemblyAI / Whisper STT upgrade
- Case grading / sealed answer keys (Case Lab v2)
- Widening the topic gate beyond data/analytics — that's a separate app

## DO NOT Do (ever)
- Call Anthropic, OpenAI, or ElevenLabs from client components
- Use the `any` TypeScript type
- Add scrollable containers to a teaching screen (see Rule 4 for the two
  records-tool exceptions)
- Hardcode API keys, or a model string in more than one place per route
- Spend tokens without calling `logUsage` with the model
- Swallow a Supabase `error` — an unchecked write is how a "ready" track shipped
  with an empty board
- Add a `middleware.ts` — this project uses `proxy.ts` (Next 16)
