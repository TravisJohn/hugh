# PRD: Narrow Learn (tracks from reference packs)

Status: **APPROVED by Travis, 2026-10-20**, as recommended, with three
corrections made on approval (below). Phase 1 architecture must be approved
before any code. Builds on `PRD-reference-packs.md` (the pack format and the
machine check).

**Corrections made on approval.** The draft was written while the
server-graded review quiz (#26) was still in progress, and three facts moved:
1. This PRD's migration is **060**; 059 became the review-quiz migration.
2. Row 9 ships the **full** approved sentence: the server-graded quiz is live.
3. Grounding the quiz in the pack is **part of this work**. The quiz is
   generated and stored on the server since #26, so the pack's key points
   and misconceptions go into that same route.

## Decisions

| # | Decision | Recommended answer | Why |
|---|---|---|---|
| 1 | Launch catalog | Launch with the two packs that exist, Linear Regression and A/B testing. The picker shows only those two; the 9-topic carousel shows only slides for packs in the catalog. More packs follow one per authoring session, starting with the carousel topics. | Waiting adds nothing for ~5 learners and delays the proof. Showing topics with no pack is the open-topic promise again. |
| 2 | How a track is built | **Deterministic, no model call.** The pack gains an authored `cards` list (8 to 14 cards, each 1 to 4 concept ids, in teaching order). The validator checks every concept sits on exactly one card and that card order respects the prerequisites. The build copies cards onto the board in that order. | Once the refinement Q&A goes, a model has no learner context to choose from, so Sonnet ordering would just be one model's opinion against the source-checked syllabus. One card per concept gives 28 cards for Linear Regression, which breaks the no-scroll board and today's 20-card cap. |
| 3 | Grounding Ask Hugh | The server, not the browser, loads the card's concepts (every key point and misconception) plus a one-line outline of the rest of the pack. The page shows the card's source links straight from the pack; the model never writes links. Beyond the card: a question covered on another card gets a short answer and the card's name. A question outside the pack is labelled "outside this course's source-checked syllabus", gets one orienting sentence at most, and gets the existing paste-into-your-own-chatbot prompt. | A tutor that says when it is off the syllabus is the product claim. Links from the pack can't be made up; links from a model can. |
| 4 | Quiz and mastery | **Mastery:** the criteria come from the card's pack key points, read on the server, not from `learning_points`, which the learner's session can edit. If the learner states a misconception's claim and leaves it uncorrected, the card cannot pass, and the feedback gives the pack's correction and its source. **Quiz:** questions still quote verified diary lines (unchanged). Each question also names the key point it tests, and wrong options may be drawn from the card's misconceptions. **Diary check:** judged against the card's key points, not the model's general knowledge. | Every judgement now has a source-backed answer key. The C10 error ("VIF removes multicollinearity") becomes something a learner can fail on. |
| 5 | Existing open-topic goals (~5 learners, 9 goals) | Keep them, read-only, labelled "Earlier topic (not source-checked)". The board and diary stay readable. Ask, quiz, mastery and rebuild are off, and nothing is deleted. Where a pack covers the same topic, offer "Start the source-checked version". | Nothing a learner made is lost, and no ungrounded tutor path has to survive. At 9 goals, this is the cheapest moment to do it. |
| 6 | Request-a-topic box | Keep one on the picker. It saves up to 120 characters to a `topic_requests` table that Travis reads in `/admin`. It makes no model call and builds nothing. It is kept with the account and deleted with it. | Demand data for choosing the next packs at no token cost, and no new route into track generation. |
| 7 | Course from document | Retire it. It is already behind `DOCUMENT_UPLOAD_ENABLED`. Park the "map a syllabus or job description onto pack concepts" idea as its own PRD once the catalog has about 10 packs, and tag the code `parked/course-from-document` before deleting it. | With 2 packs, any mapping answers "both". The 5-layer prompt-injection defence is costly to keep for a feature with nothing to map onto. |
| 8 | Retiring open-input machinery | Three phases: **(1) Proof:** the pack path ships behind `PACK_LEARN_ENABLED`, and the open path is untouched. **(2) Launch:** the picker becomes the catalog, `POST /dashboard/goals` accepts only a pack id, and the open-input routes return 410. **(3) Delete,** after a week in production with no 410s from real use. See "What is retired". | Each phase can be undone by the one before it. Nothing is deleted while it can still be reached. |
| 9 | Copy | Page title: "Hugh: learn data and analytics by conversation". Hero: "Learn data and analytics by talking it through." Subtext: Travis's approved sentence. `/home/learn` heading: "Choose a course". The landing page's Learn pillar is updated to match. Ships in phase 2, with the full sentence: both halves of the integrity work are live (#24 + 058, #26 + 059). | "You can learn anything" stops being true at phase 2. The approved sentence is true only when both halves of the integrity work are live, and they are. |
| 10 | Token cost | Track builds cost nothing, because packs remove the refine, gate, generate, rank and per-card learning-point calls. Ask carries about 2,000 more input tokens of pack context. Stable text goes first (rules, then the pack outline, then the card's concepts), with no per-request values ahead of the messages. Don't pad the prompt to reach the cache minimum. Measure on the first 20 conversations. | Estimates are below. The cache minimum on Haiku 4.5 (what Ask uses) is **4,096 tokens**, not 2,048, so short chats stay uncached either way. |
| 11 | Only machine-checked packs | A catalog file lists the live packs. CI fails if a listed pack is below `machine-checked`, and the server refuses to load one (that failure gets its own error copy, per Rule 5). To pull a pack, Travis takes it off the catalog, and its tracks go read-only like row 5. | It's enforced before deploy, so learners never meet a pack that drops a status mid-track. |
| 12 | Pack updates for learners mid-track | Tracks always read the current pack. Concept ids are permanent: a concept is marked retired, never deleted, and the validator enforces that. The goal records the pack version it was built from. | A correction to a key point should reach the learners already studying it. That is the point of checking against sources. |

## Goal

Learn teaches only from a fixed catalog of source-checked reference packs. A
learner picks a course, Hugh lays out the pack's cards, and every check on
the way (Ask, diary check, quiz, mastery) is grounded in the pack's key points
and misconceptions instead of a model's own judgement.

## Users

- **Learners** studying data and analytics. They see courses, cards, sources
  and Hugh's labels; never the pack file.
- **Travis** authors packs offline (no Hugh spend), curates the catalog, and
  reads topic requests.

## Core features

1. **Catalog picker** on `/home/learn`, which keeps its phone layout. One card
   per live pack shows the subject, the number of cards, and the sources by
   publisher. Below it are the request box (row 6) and the learner's goals,
   legacy ones included (row 5).
2. **Pack track build** through the existing machine:
   `pending → after() runs generateTrack → ready | failed`. `generateTrack`
   gains a pack branch. There is no new route and no fourth path. The build
   writes each card's title, a summary made from its concepts' outcomes, its
   `concept_ids`, and `learning_points` copied from the key points, so the
   existing checklist UI works unchanged. The first card starts in Learn and
   the rest in Backlog, and the backlog-ranking call is dropped. The two
   routes that drive the machine stay: `dashboard/goals` (body: `packId`,
   `end_date`) and `goals/[id]/retry` (rebuilds from the pack with no gate
   call, because the pack id is checked against the catalog instead). Failure
   copy and retry are unchanged. The catalog entry supplies the goal's
   `region` for the learner map, which the topic gate used to supply.
3. **Grounded Ask** (row 3). `learn/chat` takes a `milestoneId` instead of a
   browser-supplied `topic`, and builds its prompt on the server from the
   pack. This also closes a gap: today the browser chooses the tutor's
   subject. The prompt builder is a pure, tested module (Rule 7).
4. **Grounded mastery, quiz and diary check** (row 4). `buildCriteria` takes
   the card's concepts. A test proves that the criteria cannot come from
   `learning_points`.
5. **Sources on every card**: each key point's source, with its
   `#:~:text=` highlight link, rendered from the pack.
6. **One migration (060)**: `learning_goals.pack_id` and `pack_version`
   (empty means a legacy goal), `milestones.concept_ids`, and
   `topic_requests` with row-level security and account-deletion coverage.
   Travis applies it before the code deploys.

## Out of scope

Open topics in any form; learners choosing a subset of a pack's concepts or
personalising its order; document or job-description mapping (row 7);
packs beyond the two that exist; scheduled re-review ("Mastered" never
decays, a known gap); changing Ask's model; phone layouts for review and
mastery (still desktop-only); and Track Brief.

## What is retired (phase 3)

Roughly 2,650 lines, or about 3,300 counting tests:
- the topic-domain gate (`lib/learn/topic-domain*`, `classify-topic`)
- the refinement Q&A (`refine` and `goals/[id]/answers` routes,
  `RefinementFlow`, `GoalAnswers`, `TopicGateNotice`, `gateHistory`, the
  refine prompts)
- course from document (`goals/document/*`, `DocumentUploadFlow`,
  `lib/documents`)
- the open-topic generation prompt, backlog priority, and the per-card
  learning-points call
- the generation replay harness

`lib/learn/topicInput.ts` stays only if the request box needs its length
check. The `track_generations` table stays for its history and records
`pack` builds from now on. CLAUDE.md is updated at the same time: Rule 3
(two routes, not three), the topic-gate row in Key Design Decisions, and
the surfaces table.

## Token cost (estimates from the code, not measured)

- **Track build, today:** about $0.06 to $0.10 per goal. That covers
  refinement questions, the refined title, two gate calls, milestone
  generation (Sonnet, up to 2,048 output tokens), ranking, and 8 to 14
  learning-point calls. **With packs: $0.**
- **Ask, per turn:** the system prompt grows from about 1,500 tokens to about
  3,500 (the card's concepts at 600 to 900 tokens, plus a pack outline of
  800 to 1,200). On Haiku 4.5, uncached, that adds about $0.002 per turn.
  Once a conversation passes 4,096 tokens, the prefix caches, and each later
  turn reads it at 0.1 times the input price. Expect about one cent more per
  conversation, which a single avoided track build covers several times
  over. Sending the whole pack (about 6,000 tokens) would cache from turn
  one, but it costs more for short chats and blurs which card is in focus.

## Success criteria

1. Picking Linear Regression gives a ready board in under 5 seconds, with no
   `tracker/*` rows in `usage_logs` for that build.
2. Every card's checklist, Ask context and mastery criteria trace to pack
   concept ids. The test in feature 4 passes.
3. In a scripted check of 10 questions (on this card, on another card, and
   outside the pack, including an item from `outOfScope`), Hugh labels every
   question outside the pack and never presents one as source-checked.
   Travis reads the transcript.
4. Stating "VIF removes multicollinearity" in a mastery session on the
   collinearity card does not pass, and the feedback links Penn State's
   passage.
5. After phase 2, every retired route returns 410, and a test hits each one.
6. CI fails when a catalog pack is set below `machine-checked`.
7. Ask's spend across the first 20 conversations is within the estimate above,
   and `cache_read_input_tokens` is above zero after the conversation passes
   the cache minimum.

## Proof plan: Linear Regression end to end

1. **Pack v1.2:** add `cards` to the format and to the Linear Regression pack
   (offline), with validator rules and tests. Confirm the machine-check
   fingerprint is unchanged, because cards are not key points.
2. **Migration 060**, written and handed to Travis to apply.
3. **Pure modules with tests:** `lib/packs/catalog.ts` (live packs, load by
   id, the status gate), `lib/packs/track.ts` (pack to card rows), and the Ask
   prompt builder.
4. **Pack branch in `generateTrack`,** plus the goals and retry routes, all
   behind `PACK_LEARN_ENABLED`.
5. **Ask, mastery, the diary check and the review quiz** read the pack. The
   quiz route (server-stored since #26) tags each question with the key point
   it tests and may draw wrong options from the card's misconceptions.
6. **Travis's test checklist** (he drives the browser): pick the course,
   check the card order, ask the 10 scripted questions, state the VIF
   misconception in mastery, and open three source links.
7. **A/B testing** goes through the same steps (cards only). Then phase 2.

## Phase 1 architecture (APPROVED by Travis, 2026-10-20, all four decisions)

Phase 1 is the Linear Regression proof behind a flag. The open-topic path is
untouched, and no learner sees anything new.

### Modules

**Pack format v1.2** (`types/pack.ts`, `lib/packs/validate.ts`)
- `cards: PackCard[]`, each `{ id, title, conceptIds }`, in teaching order.
- `retired?: true` on a concept (row 12). Retired concepts are kept, never
  deleted.
- New validator rules: 8 to 14 cards; 1 to 4 concepts per card; every live
  concept on exactly one card; card order respects prerequisites; card and
  concept ids unique. Ids are permanent, so a test compares them against the
  previous version of each pack.
- The machine-check fingerprint covers key points and misconceptions only.
  Adding cards must leave it unchanged, and a test proves that.

**Pure modules, each with tests** (`lib/packs/`)
- `catalog.ts`: the live packs, imported statically so they are bundled on
  Vercel. `loadPack(id)` returns the pack, or `unknown` / `below-status`, each
  with its own error copy (Rule 5). It also supplies each pack's `region`.
- `track.ts`: turns a pack into card rows (`title`, `summary`, `concept_ids`,
  `learning_points`, `kanban_column`, `position`). The first card starts in
  Learn and the rest in Backlog. No model is involved.
- `grounding.ts`: given a card's qualified concept ids
  (`linear-regression:ols`), returns its concepts, key points,
  misconceptions, sources, and a one-line outline of the rest of the pack.
  This is the ONE place Ask, mastery, the diary check and the quiz read a
  pack from (DRY).
- `askPrompt.ts`: the Ask system prompt, built from the grounding. Stable
  text goes first, so the prompt cache can hit.

**Migration 060** (additive; Travis applies it before the code deploys)
- `milestones.concept_ids text[]`. Learners cannot write it: since 058 they
  hold only named column grants, and new columns are not granted. Grounding
  keys off this column.
- `learning_goals.pack_id`, `pack_version`. These are for display and for
  listing only. Grounding never trusts them, because learners can write
  `learning_goals`.
- Widen `track_generations.source_kind` to allow `'pack'`. Today the CHECK
  allows only `qa` and `document`, so a pack build's provenance row would be
  refused.
- `topic_requests` stays in phase 2, when the request box ships.
- A SQL test beside 058's and 059's, run in CI.

**Wiring (server)**
- `generateTrack` takes a source: `{ kind: "topic", ... }` as today, or
  `{ kind: "pack", packId }`. The track and milestone writes, the partial
  insert check, and the provenance record stay one shared path. The pack
  branch skips the model calls and the ranking call. Rule 3 holds: one
  machine, no new route.
- `dashboard/goals` and `goals/[id]/retry` accept `packId` when the flag
  allows. There is no topic gate on this path; the catalog is the gate.
- `learn/chat` accepts `milestoneId`. A pack card gets the server-built
  prompt; a legacy card keeps today's `topic` path until phase 2.
- `buildCriteria` (mastery evaluate, session and realtime), the diary check
  (`entries/[id]/verify`) and the review quiz (`review/quiz`) read
  `grounding.ts` for pack cards. A test proves mastery criteria for a pack
  card cannot come from `learning_points`.
- The coverage route already skips its model call when `learning_points` is
  non-empty, and pack cards are built with theirs.

**UI**
- `/home/learn`: a "Courses" section above today's picker, for the flagged
  user only.
- Card drawer: a Sources list for pack cards (key point, publisher, highlight
  link), passed in by the board page. The browser never builds links.

**Flag**
- `PACK_LEARN_ENABLED`, admin-only in production, using the same pattern as
  `canUseRealtime`. Travis can test on the live site, and learners see
  nothing.

### Build order: two PRs
- **PR A, "a pack becomes a board":** v1.2 format plus the Linear Regression
  cards (drafted offline, Travis glances at the order); `catalog`, `track`;
  060 plus its SQL test; the `generateTrack` pack branch; the goals and retry
  routes; the picker section. Travis's check: pick Linear Regression and get
  a ready board in under 5 seconds with no `tracker/*` usage rows.
- **PR B, "everything reads the pack":** `grounding`, `askPrompt`; Ask,
  mastery, the diary check and the quiz; card sources. Travis's check: the
  10 scripted Ask questions, the VIF misconception failing mastery, three
  source links.
- **Then** A/B testing gets its cards (format only), and phase 2 is planned
  separately.

### Decisions in this architecture
1. **The flag is admin-only in production.** The alternative, a separate
   preview environment, costs a second Supabase project.
2. **Pack builds skip the token usage gate,** because they spend nothing.
   Goal creation keeps its existing limits. CLAUDE.md Rule 3 ("each must gate
   usage") is reworded to "each must gate the spend it causes".
3. **Grounding keys off `milestones.concept_ids`, not `learning_goals.pack_id`,**
   for the reason in migration 060 above.
4. **Two PRs, not one,** so each can be checked on the live site on its own.

## Phase 2 architecture (DRAFT, 2026-10-25, awaiting Travis's approval)

Phase 2 is the launch (row 8): every learner gets the catalog, and the open
topic path closes. Nothing is deleted; that is phase 3. Main holds 16
machine-checked courses (12 Statistics, 4 Machine Learning), not the two
row 1 planned for.

### What changes, by module

**1. The catalog opens to every learner** (`lib/packs/access.ts`)
- `canUsePackLearn` stops requiring `is_admin`. Any signed-in, unblocked
  learner may pick a course. Its five callers (the goals and retry routes,
  `/home/learn`, `DashboardPanel`, `CourseCatalog`) keep calling it, so the
  rule stays in one place.
- `PACK_LEARN_ENABLED` is removed (decision 1).

**2. `/home/learn` becomes "Choose a course"** (rows 1, 6, 9)
- `CourseCatalog` is the whole picker. `DashboardPanel` stops mounting the
  topic input, `RefinementFlow`, `DocumentUploadFlow` and `TopicGateNotice`;
  their files stay until phase 3.
- **Courses are organised by natural grouping, not crammed onto one screen**
  (Travis, 2026-10-25). The picker shows one group at a time, so Rule 4 holds
  without an exception:
  - Level 1 is the list of groups. Each shows its name, one line on what it
    covers, and how many courses it has.
  - Level 2 is the chosen group's courses as compact rows: the subject, the
    number of cards, and the sources by publisher. The Statistics
    foundations are numbered 1 to 7 as a path.
  - The duration chips and Start button appear only on the selected course,
    not on every card. Repeating them on every card is what makes today's
    flat list too tall.
  - On a phone the two levels are full-width screens with a back button.
  - The chosen group lives in the URL (`?group=`), so a link or a carousel
    slide can open a group with its course already selected.
  - If a group outgrows the screen, it pages, the way the goal library
    already pages.
- **The groups are data, in one place.** A pure module,
  `lib/packs/groups.ts`, lists the groups in display order. Each group has an
  id, a label, a one-line blurb, whether it is a path, and its learner-map
  region. Each catalog entry names its `group` instead of a `region`, and its
  region is read from that group, so the two can't disagree.
- Tests check that every entry names a known group, no listed group is
  empty, and a path's order is catalog order. Groups with no courses yet
  (Analytics, Data Engineering) are not shown. The starting groups are
  decision 5.
- The carousel shows only slides whose course is in the catalog: 7 of 9 today
  (Gradient descent and Reinforcement learning drop out). A slide opens its
  course's group with that course selected, instead of filling a topic box. Each slide names a `packId`, and a
  test holds every slide to a catalog id.
- The request box (row 6) sits under the catalog: up to 120 characters,
  saved, with no model call and no build. A pure module
  (`lib/learn/topicRequest.ts`) owns the length and rate rules: 5 per learner
  per day. `/admin` lists the requests.

**3. Migration 061: `topic_requests`** (additive; Travis applies it before
the code deploys)
- `id`, `user_id` (cascades on account delete), `text` (1 to 120
  characters), `created_at`. RLS on. Learners may INSERT their own rows and
  nothing else; the admin reads with the service role.
- A SQL test beside 058 to 060: learners can't read others' requests, can't
  update any, and account deletion removes theirs.
- Kept until the account is deleted, which matches the retention policy, so
  `lib/retention.ts` is unchanged. `/privacy` gains one line saying requests
  are stored.

**4. Goal creation takes only a course** (`dashboard/goals`, `goals/[id]/retry`)
- `POST /dashboard/goals` accepts `{ packId, end_date }` only. A body with a
  `topic` gets a 400 with its own copy pointing at the catalog. The topic
  branch (checkTopic, refinement, gate re-judge) is no longer reachable.
- Retry rebuilds course goals as today. A legacy goal is refused with
  "Earlier topics can't be rebuilt", plus a link to choose a course: a way
  out, not a dead end (Rule 5).
- Rule 3 then has two drivers, not three, because `goals/document/approve`
  stops driving the machine. CLAUDE.md is updated in this PR, not in phase 3,
  since this is the PR that makes the old text untrue.

**5. The open-input routes return 410**
- `classify-topic`, `refine`, `goals/[id]/answers`, `goals/document/extract`
  and `goals/document/approve`. One shared helper returns the 410 and its
  copy (DRY), and records a new `learn.retired_route` operation through
  `recordOperation`.
- That record is phase 3's trigger: the PRD says to delete after a week in
  production with no 410s from real use, and today nothing would count them.
- A table-driven test hits every retired route (success criterion 5).
- The registry keeps listing these routes until their files go; the Learn
  entry's guards are updated for routes that now spend nothing.

**6. Legacy goals are read-only** (row 5; row 11 for pulled packs)
- `cardGrounding` already sorts every card three ways: `none` (no concept
  ids, so a legacy card), `ok`, or `refused`. Phase 2 changes what `none`
  means, from "keep the old behaviour" to "read-only". That is one switch
  point, not a check copied into each route.
- Ask (`learn/chat`), the review quiz, mastery (`session`, `evaluate`,
  `realtime-session`), the diary check (`entries/[id]/verify`) and rebuild
  each refuse a `none` card with the same copy: "This is an earlier topic,
  kept for you to read. It wasn't built from a source-checked course." The
  board and diary stay readable, and deleting stays allowed (retention).
- `learn/chat` requires `milestoneId`, and the browser's `topic` is ignored.
  `focusedLearningSystemPrompt` goes unused and is deleted in phase 3.
- The goal library and the board header label legacy goals "Earlier topic
  (not source-checked)", with a link to choose a course (decision 3).
- A pulled pack's cards already come back `refused`. They get the same
  read-only treatment, with the pack's own refusal copy.

**7. Copy** (row 9)
- `app/layout.tsx`: the title, Open Graph and Twitter titles become "Hugh:
  learn data and analytics by conversation". The three descriptions drop
  "Build a structured learning plan", because learners no longer build the
  plan.
- `app/page.tsx`: the hero becomes "Learn data and analytics by talking it
  through.", with Travis's approved sentence as the subtext; the Learn pillar
  matches.
- A test fails if "learn anything" appears in app copy again.

### Build order: two PRs
- **PR C, "the catalog for everyone":** 061 and its SQL test; the request box
  and its `/admin` list; `/home/learn` as the catalog; the carousel; the copy;
  the flag removed. The open routes still answer direct calls, but nothing in
  the app reaches them. Travis's check, as a learner (not admin): the picker
  fits the screen on desktop and phone, a course builds a ready board with no
  `tracker/*` usage rows, and a request appears in `/admin`.
- **PR D, "the open path closes":** goals and retry take only a course; the
  410s and their test; legacy goals read-only; `learn/chat` keyed on the
  card. Travis's check: on a legacy goal, Ask, the quiz, mastery and rebuild
  each show the read-only copy, and the board still opens.
- Phase 3 (deleting about 2,650 lines and tagging
  `parked/course-from-document`) starts after a week of PR D in production
  with no `learn.retired_route` events from real use.

### Decisions for Travis
| # | Decision | Recommended answer | Why |
|---|---|---|---|
| 1 | The flag | Delete `PACK_LEARN_ENABLED`. Undo by Vercel's instant rollback to the previous deployment. | Once the topic input is gone, turning the flag off would leave learners with no way to start anything, so it can't serve as a kill switch. 061 is additive, so a rollback is safe. |
| 2 | How read-only is a legacy goal | Ask, quiz, mastery, diary check and rebuild are off (as row 5). Moving cards and adding diary entries are off too. Deleting stays on. | "Read-only" then means what it says. Progress on an unchecked syllabus is what the narrowing exists to stop. |
| 3 | "Start the source-checked version" | One "Choose a course" link on every legacy goal, rather than matching each topic to a pack. | A matcher, whether a model or fuzzy text, is not worth it for about 9 goals. A link can't pick the wrong course. This narrows row 5. |
| 4 | Outlier detection's region | Keep it under Statistics. | Learners see regions from PR C onward, so this should be settled before then. The pack is mostly statistical tests. |
| 5 | The starting groups | **Statistics foundations** (a path, in order): Descriptive statistics, Probability distributions, Sampling and survey design, Sampling distributions, Hypothesis testing, Comparing groups, Categorical data. **Statistical modelling:** Linear regression, Bayesian inference, Time series forecasting. **Statistics in practice:** A/B testing, Outlier detection. **Machine learning:** Classification metrics, Decision trees, Neural networks, Clustering. | Groups follow what a learner is trying to do: build the basics in order, model a response, run an experiment or catch bad data, then predict or group with a model. The first three sit in the Statistics region and the fourth in Machine Learning, so the learner map is unchanged. No pack cites another pack's concepts, so the grouping comes from purpose, not a dependency graph. |

### Risks
- **The largest group at phone height:** the 7-course foundations path is
  the tallest level-2 view. Seven compact rows should fit at 812px, but
  Travis checks it in the browser. Growth past that is handled by paging
  inside the group, not by scroll.
- **Registry guards:** the CI guards may object to routes that stop spending,
  or to components that stop being mounted. Each is fixed in the guard, not
  by keeping dead code reachable.
- **Legacy count:** re-count legacy goals and learners in production before
  building PR D. The PRD's 9 goals date from 2026-10-19.
