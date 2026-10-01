# Hugh

Hugh is an AI-powered learning platform for data and analytics. A learner picks
a topic, Hugh generates a track of milestone cards, and the learner works
through them: asking questions, keeping a learning diary, proving mastery out
loud, drilling code, and working business cases. Built on Next.js 16 (App
Router) with Supabase for auth/data and Anthropic and OpenAI for
the AI/voice features.

The mock-interview loop it began as was deleted on 2026-08-24; the learning loop
is the product.

For product context, architecture rules, folder layout, and the AI model
selection policy, see [`CLAUDE.md`](./CLAUDE.md) — that file is the source of
truth for how this codebase is organized and why. `PROJECT_LOG.md` has the
running history of decisions and milestones.

If you are restoring this project from scratch, or rolling back to the
known-good state, read [`RESTORE.md`](./RESTORE.md) first — it covers what the
stable tag does and does not bring back.

## Prerequisites

- Node.js `>=20.9.0` (matches the `engines` field in `package.json` and
  Next.js's own minimum; developed against Node 24.x)
- A Supabase project (Postgres + Auth + Storage)
- An API key for Anthropic (required); OpenAI (optional — gates
  the Notes Coach/summarize and Realtime mastery features, which fail
  gracefully with a 503 if unset)

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in real values — see below
npm run health                # verifies env vars + that each provider key actually works
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment variables

See [`.env.example`](./.env.example) for the full list with explanations of
what each one gates. In short:

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Server-only. Learn/chat and track generation. |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Public by design — used by the browser Supabase client. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only. Bypasses RLS — never expose to the client. |
| `SUPABASE_ACCESS_TOKEN` | No | Only needed for `scripts/run-migration.ts` (CLI migration apply). |
| `OPENAI_API_KEY` | No | Server-only. Notes Coach/summarize, Realtime mastery, local architecture-dashboard assistant. |
| `MASTERY_REALTIME_ENABLED` | No | Feature flag — `"true"` allows an unblocked administrator to preview OpenAI Realtime voice. |

`NEXT_PUBLIC_` vars are safe for the client bundle; every other key is
server-only and must only be read from `/app/api/**` route handlers, Server
Components, or `lib/**` modules marked `import "server-only"`.

### Database

Schema lives in [`supabase/migrations/`](./supabase/migrations) as numbered,
sequential SQL files — apply them in order via the Supabase Dashboard SQL
editor (or `scripts/run-migration.ts` from the CLI, which needs
`SUPABASE_ACCESS_TOKEN`). There is no down-migration/rollback tooling yet;
treat each migration as forward-only and review it before applying to a
project with real data. Row Level Security is enabled on every table —
`supabase/migrations/032_lock_down_profiles_rls.sql` is the fix for a
critical RLS gap found in the deployment-readiness audit (see below) and
should be applied before any production launch.

## Scripts

```bash
npm run dev      # start the dev server (also runs the architecture-dashboard prebuild)
npm run build    # production build
npm run start    # run a production build locally
npm run lint     # ESLint
npm test         # Vitest (unit tests, run once)
npm run test:watch
npm run health   # verify env vars are set AND that each provider key actually authenticates
```

CI runs on every push to `main` and on every pull request:
`.github/workflows/ci.yml` gates on `lint`, `tsc --noEmit`, `test`,
`npm audit --omit=dev` and `build`, secretless, on Node 20.x. Run the same set
locally before opening a pull request.

## Deployment status

**This repository has an outstanding security/readiness audit —
[`DEPLOYMENT_READINESS_AUDIT.md`](./DEPLOYMENT_READINESS_AUDIT.md) — that
gates public deployment.** Read it before deploying to production. It
documents what's already fixed, what's still open, and the recommended
remediation order. Start with its **"Re-check: 6 September 2026"** section — that is the current
standing, and it reads **ready for production deployment** with all six
original release blockers closed. The 4 August and 22 August sections above it
are the original record, left unedited on purpose; where they disagree, the
newest section wins. The intended host is [Vercel](https://vercel.com); there
is no `vercel.json` — project settings (env vars, build command) are
configured directly in the Vercel dashboard.
