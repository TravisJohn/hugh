# PRD — Reference packs (v1)

Status: **draft for Travis**, 2026-10-19. Scope: the pack format only.

## Goal

A reference pack is the source-checked syllabus for one Learn topic. It records
which concepts the topic covers, the order they build in, and what Hugh may say
about each one, and every statement traces to a named source.

v1 proves the format on one topic, Linear Regression, before any app code
changes. This is the first step of narrowing Learn from open topics to a fixed
catalog. That decision was made on 2026-10-19 because every earlier grounding
attempt had a model judging a model. The one real error the eval pilot caught
(card C10 calling VIF analysis a remedy for multicollinearity) came from
checking against sources.

## Who uses a pack

- **Hugh, later:** to build a track by selecting and ordering a pack's
  concepts, and to answer in Ask from a concept's key points. Neither happens
  in v1.
- **Travis:** to review and approve each pack.
- **Learners** never see the file. They see its effects, and its citations.

## What a pack contains

**Pack:** `id`, `version` (semver), `status` (`draft` → `provisional` →
`approved`), `subject`, `outOfScope[]`, `sources[]`, `concepts[]`,
`prerequisites[]`, and `review` (filled in at approval).

**Source:** `id`, `title`, `publisher`, `url`, `license` (when the publisher
states one), `accessedAt`.

**Concept:** `id`, `title`, `outcome` (what the learner can do afterwards),
`keyPoints[]` (2–5), and optionally `misconceptions[]` (0–3) and `aliases[]`.

**Key point:** `text` (our own words, 40 words or fewer), `sourceId`,
`locator` (the section or lesson), and `quote` (25 words or fewer, verbatim from
that page).

**Misconception:** `claim` (the wrong belief), `correction`, `sourceId`,
`locator`, `quote`.

**Prerequisite:** `before`, `after`, `reason`.

Illustrative only; the quotes shown are placeholders, not real source text:

```json
{
  "id": "collinearity",
  "title": "Collinearity",
  "outcome": "Recognise when predictors are strongly related and explain what it does to coefficient estimates.",
  "keyPoints": [
    { "text": "When predictors are highly correlated, coefficient estimates become unstable and their standard errors grow.",
      "sourceId": "psu-501", "locator": "Lesson 12", "quote": "<verbatim sentence from the cited page>" }
  ],
  "misconceptions": [
    { "claim": "VIF analysis removes multicollinearity.",
      "correction": "VIF measures how much collinearity inflates the variance of an estimate; it detects the problem and does not fix it.",
      "sourceId": "psu-501", "locator": "Lesson 12", "quote": "<verbatim sentence from the cited page>" }
  ]
}
```

## What "source-checked" means

A pack becomes **provisional** only when the validator passes all of these:

1. The schema is valid, ids are unique, and every reference resolves.
2. Every key point and misconception has a source and a quote, and the quote
   is found on the fetched page (with whitespace and case normalised). Pages
   that cannot be fetched, and PDFs, are listed for a manual check instead.
3. The prerequisites form no cycle, so a valid learning order exists.
4. Every quote is 25 words or fewer, and every key point 40 words or fewer.

A pack becomes **approved** only after Travis has spot-checked at least five
randomly chosen key points against their pages. The pack records who checked
it, when, and which items were sampled.

What the validator does **not** prove: a quote being on the page shows the
source says it, not that our key point paraphrases it fairly. That is what the
spot-check is for.

## How a pack is authored

In Claude Code, on Travis's Claude subscription, so no Hugh API spend. The
steps are: fetch the sources, draft, validate, fix, spot-check, approve,
commit. That is roughly one session per pack.

Packs store our own wording, short attributed quotes and links. They never
store copies of source text.

## Where packs live

- `content/packs/<id>.json`, read by the server. Packs do not go in `public/`:
  the quotes are third-party text, and nothing in the browser needs to
  download them.
- The validator's rules live in `lib/packs/validate.ts`, a pure module with
  unit tests beside it (Rule 7). `scripts/validate-pack.ts` fetches the pages
  and runs those rules.

## Out of scope for v1

The catalog UI; building tracks from packs; grounding Ask in packs; learner
profiles and personalisation; mapping a client's problem onto a pack;
scheduled re-review; and any pack other than Linear Regression.

## Success criteria

1. The Linear Regression pack, rebuilt in this format, passes the validator.
2. Travis approves it after spot-checking at least five key points.
3. The known C10 error becomes checkable: the collinearity concept records
   the VIF misconception, with its source.
4. The format survives a second topic: writing the A/B testing pack needs no
   schema change. If it does, the format is fixed before a third pack is
   written.

## Open questions

1. **PDF sources** (for example, the Stanford CS229 notes): allowed in v1?
   Recommendation: allow them, flagged for a manual quote check.
2. **Key points per concept:** is 2–5 enough for Ask later, without bloating
   its context? Recommendation: start at 2–5 and revisit when Ask is
   grounded.
