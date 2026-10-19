# PRD — Reference packs (v1)

Status: **approved by Travis**, 2026-10-19, with verbatim quotes replaced by
text anchors (see "Why anchors, not quotes"). Scope: the pack format only.

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
`locator` (the section or lesson; a page number for a PDF), and `anchor`.

**Anchor:** `start` and `end`, each 2–6 words copied exactly from the source.
They mark where the supporting passage begins and ends. The passage itself is
never stored.

**Misconception:** `claim` (the wrong belief), `correction`, `sourceId`,
`locator`, `anchor`.

**Prerequisite:** `before`, `after`, `reason`.

Illustrative only; the anchors shown are placeholders, not real source text:

```json
{
  "id": "collinearity",
  "title": "Collinearity",
  "outcome": "Recognise when predictors are strongly related and explain what it does to coefficient estimates.",
  "keyPoints": [
    { "text": "When predictors are highly correlated, coefficient estimates become unstable and their standard errors grow.",
      "sourceId": "psu-501", "locator": "Lesson 12",
      "anchor": { "start": "<first words of the passage>", "end": "<last words of the passage>" } }
  ],
  "misconceptions": [
    { "claim": "VIF analysis removes multicollinearity.",
      "correction": "VIF measures how much collinearity inflates the variance of an estimate; it detects the problem and does not fix it.",
      "sourceId": "psu-501", "locator": "Lesson 12",
      "anchor": { "start": "<first words of the passage>", "end": "<last words of the passage>" } }
  ]
}
```

## Why anchors, not quotes

The first draft stored a verbatim quote for each key point. That would have
copied around a hundred excerpts of licensed text into a public repository
that belongs to a product with a paid plan. Penn State STAT 501 is CC BY-NC
4.0 (non-commercial only), and the ISLR and CS229 material is plain copyright.
Facts are free to state in our own words; a source's exact sentences are not.

An anchor keeps the proof without the copying. The validator confirms that
the start words, and then the end words shortly after them, appear on the
page. It then prints a link ending in `#:~:text=start,end`, which opens the
page scrolled to the passage and highlighted, so a spot-check is one click.

## What "source-checked" means

A pack becomes **provisional** only when the validator passes all of these:

1. The schema is valid, ids are unique, and every reference resolves.
2. Every key point and misconception has a source and an anchor. The anchor's
   start words appear on the fetched page exactly once, and its end words follow
   within 600 characters (whitespace, case and typographic quotes normalised).
   Pages that cannot be fetched or yield no text are listed for a manual check.
   PDFs are checked against their extracted text but still listed for a manual
   check, because browsers do not highlight text inside PDFs.
3. The prerequisites form no cycle, so a valid learning order exists.
4. Every concept has 2–5 key points and at most 3 misconceptions, every key
   point is 40 words or fewer, and each anchor's start and end are 2–6 words.

A pack becomes **approved** only after Travis has spot-checked at least five
randomly chosen key points against their pages. The pack records who checked
it, when, and which items were sampled.

What the validator does **not** prove: an anchor being on the page shows the
source has a passage there, not that our key point paraphrases it fairly. That
is what the spot-check is for.

## How a pack is authored

In Claude Code, on Travis's Claude subscription, so no Hugh API spend. The
steps are: fetch the sources, draft, validate, fix, spot-check, approve,
commit. That is roughly one session per pack.

Packs store our own wording, links, and a few anchor words per passage. They
never store copies of source text.

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

## Decided at approval

1. **PDF sources** (for example, the Stanford CS229 notes) are allowed. They
   are checked against extracted text and always flagged for a manual check.
2. **Key points per concept:** 2–5. Revisit when Ask is grounded in packs.
