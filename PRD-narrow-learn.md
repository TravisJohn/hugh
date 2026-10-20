# PRD: Narrow Learn (tracks from reference packs)

Status: **draft for Travis's approval**, 2026-10-20. No code until approved.
Builds on `PRD-reference-packs.md` (the pack format and the machine check).
The review-quiz grading work is a separate session; this PRD defines only
what the quiz reads from a pack.

## Decisions (reply "approved", or "approved, except row N: ...")

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
| 9 | Copy | Page title: "Hugh: learn data and analytics by conversation". Hero: "Learn data and analytics by talking it through." Subtext: Travis's approved sentence. `/home/learn` heading: "Choose a course". The landing page's Learn pillar is updated to match. Ships in phase 2, and only if the server-graded quiz is live by then; until it is, drop the final clause ("counts something as learned..."). | "You can learn anything" stops being true at phase 2. The approved sentence is true only when both halves of the integrity work are live. |
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
6. **One migration (059)**: `learning_goals.pack_id` and `pack_version`
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
2. **Migration 059**, written and handed to Travis to apply.
3. **Pure modules with tests:** `lib/packs/catalog.ts` (live packs, load by
   id, the status gate), `lib/packs/track.ts` (pack to card rows), and the Ask
   prompt builder.
4. **Pack branch in `generateTrack`,** plus the goals and retry routes, all
   behind `PACK_LEARN_ENABLED`.
5. **Ask, mastery and diary check** read the pack. Hand the quiz interface
   (key point ids and misconceptions per card) to the quiz session.
6. **Travis's test checklist** (he drives the browser): pick the course,
   check the card order, ask the 10 scripted questions, state the VIF
   misconception in mastery, and open three source links.
7. **A/B testing** goes through the same steps (cards only). Then phase 2.
