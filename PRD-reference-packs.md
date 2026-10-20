# PRD — Reference packs (v1)

Status: **approved by Travis**, 2026-10-19, with verbatim quotes replaced by
text anchors (see "Why anchors, not quotes"). Scope: the pack format only.

**v1.1 amendment (approved by Travis, 2026-10-20, with the recommended
defaults):** adds a `machine-checked` status, where a stronger model judges
every key point against its source passage. See "The machine check". Human
approval becomes an audit, not a gate.

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
  in v1. From v1.1, Hugh may use a pack once it is `machine-checked` or
  `approved`, and never while it is `draft` or `provisional`.
- **Travis:** to audit packs (v1.1). In v1 he approved each one.
- **Learners** never see the file. They see its effects, and its citations.

## What a pack contains

**Pack:** `id`, `version` (semver), `status` (`draft` → `provisional` →
`machine-checked` → `approved`), `subject`, `outOfScope[]`, `sources[]`,
`concepts[]`, `prerequisites[]`, `machineCheck` (filled in by the machine
check, v1.1) and `review` (filled in by a human audit).

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

What the validator does **not** prove: an anchor being on the page shows the
source has a passage there, not that our key point paraphrases it fairly.

The four statuses, in order (the third is new in v1.1):

| Status | What it means | Who or what grants it |
|---|---|---|
| `draft` | Being written | The author |
| `provisional` | Every anchor was found on its live page | The validator |
| `machine-checked` | A stronger model judged every key point fair to its passage, and caught every planted error | The machine check |
| `approved` | A person also audited a sample and agreed | Travis |

In v1, **approved** came straight after provisional and required Travis's
spot-check of at least five random key points. In v1.1 that spot-check becomes
the audit described below, and a pack can be used by Hugh at `machine-checked`.

## The machine check (v1.1)

**Why a model can do this job.** Earlier grounding attempts asked a model
whether something was *true*, with nothing to check against. This asks
something much narrower: here is a source passage, and here is our sentence;
does the sentence say only what the passage supports? That is reading
comprehension against evidence the judge can see, and the truth still comes
from the source. The judge does not decide whether the source is right, and it
does not decide what the curriculum should be.

**The judge.**
- **Separate from the author.** It runs as its own model call, in a fresh
  context, never in the session that wrote the pack.
- **At least as capable as the author.** It uses the most capable Claude model
  available to the authoring session at the time, and the pack records which
  model it was.
- **Blind.** For each item it sees only the passage (the text between the
  anchors, as the validator extracts it) and the sentence. It never sees the
  author's notes, the concept title, or which items are planted errors.

**What it judges.** Every key point and every misconception, not a sample.
- For a key point, the sentence is the key point's text.
- For a misconception, it judges the correction, and confirms the passage
  conflicts with the claim.

**Its verdicts.** One per item, with a reason of 25 words or fewer in the
judge's own words. The reason never copies the passage.
- `supported`: everything the sentence says is stated in, or directly follows
  from, the passage.
- `partly`: some of it is supported, but the sentence adds to it, overstates
  it, or narrows it.
- `not_supported`: the passage does not back it.
- `contradicts`: the passage says otherwise.

**Planted errors (calibration on every run).** Each run mixes deliberately
unfaithful items in among the real ones, and the judge cannot tell them apart.
There are at least 5, or 10% of the real items if that is more. They include:
- every misconception's *claim* stated as if it were true (for example, "VIF
  analysis removes multicollinearity" against Penn State's VIF passage)
- corrupted copies of real key points: a negation, an overstatement ("always",
  "guarantees"), a wrong number or direction, an unsupported addition, and a
  causal claim drawn from an association

A judge that calls a planted error `supported` has proved its approvals
cannot be trusted on that run.

**The pass rule.** A pack becomes `machine-checked` only when:
1. every real key point and misconception is `supported`;
2. every planted error gets any verdict other than `supported`; and
3. the run is recorded.

A real item judged `partly`, `not_supported` or `contradicts` is rewritten,
re-anchored and judged again. A missed planted error fails the whole run. A
re-run is allowed only after the judge's instructions have changed, and that
change is recorded, so a pass cannot be won by simply trying again.

**The record (`machineCheck`):** the judge model, the date, the number of
items judged and supported, the number of planted errors and how many were
caught, and a fingerprint of the key point texts and anchors it judged. If any
key point or misconception changes afterwards, the fingerprint no longer
matches, and the validator moves the pack back to `provisional` until it is
judged again.

**Where it runs.** In the authoring session, on Travis's Claude subscription,
with no Hugh API spend and nothing that needs secrets in CI. The validator
prepares the judge's packet of passages, sentences and planted errors, then
reads the verdicts back and writes the record and status. Passages and
verdicts stay in `.pack-cache/`, which is git-ignored, because they contain
source text.

**The human audit.** Travis audits 5 items in at least one of every five
machine-checked packs, or in any pack he chooses, using the review page that
shows each sentence beside its passage. The audit records whether he agreed
with the judge.
- If he agrees on all items, the pack becomes `approved`.
- If he disagrees with any `supported` verdict, the pack drops to
  `provisional`, and the judge's instructions are reviewed before any other
  pack is machine-checked.

Agreement across audits is how the judge's reliability is measured over time.

**What the machine check does not prove:** that a source is correct, that the
concept list is complete, or that the order is the best one for a particular
learner. Those stay with the author and with Travis's audits.

## How a pack is authored

In Claude Code, on Travis's Claude subscription, so no Hugh API spend. The
steps are: fetch the sources, draft, validate, fix, spot-check, approve,
commit. That is roughly one session per pack.

From v1.1 the steps are: fetch the sources, draft, validate, fix, set
`provisional`, run the machine check, fix and re-judge until it passes, set
`machine-checked`, commit. Travis then audits on his own schedule.

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

## v1.1 success criteria

1. The Linear Regression and A/B testing packs both reach `machine-checked`,
   with every planted error caught.
2. Planted as an error, the C10 claim ("VIF analysis removes
   multicollinearity") is judged `not_supported` or `contradicts`.
3. Editing any key point after a machine check moves the pack back to
   `provisional`, enforced by the validator and tested.
4. Travis's first audit agrees with the judge on all five items.

## Decided at v1.1 approval

1. **Audit cadence:** at least one in every five machine-checked packs.
2. **Planted errors per run:** at least 5, or 10% of the items if that is
   more. Raise it if an audit ever catches something the judge passed.
3. **Judge model, first runs:** Claude Fable 5.1 needs usage credits beyond the
   subscription, so the first runs used Claude Opus 5.5, the most capable model
   the subscription includes, in a fresh blind context. That is the same model
   that authored the packs. Re-judging with Fable later is a re-run, and the
   record names the judge either way.
