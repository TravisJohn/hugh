# Reference packs

Each file is the source-checked syllabus for one Learn topic. The format and
the rules live in [`PRD-reference-packs.md`](../../PRD-reference-packs.md); the
types in [`types/pack.ts`](../../types/pack.ts); the rules in
[`lib/packs/`](../../lib/packs/).

A pack stores our own wording, links, and a few **anchor** words at each end of
the passage that supports each key point. It never stores a source's text.

## Writing a pack

1. **List the sources first.** Create `<id>.json` with `status: "draft"`, the
   sources, and empty `concepts` and `prerequisites`. Prefer HTML pages over
   PDFs: an HTML anchor gives the reviewer a one-click highlight, while a PDF
   anchor is always a manual check.
2. **Fetch them:** `npm run packs:check -- <id> --dump`. This writes each
   source's extracted text to `.pack-cache/<id>/`, which is git-ignored. Write
   anchors against this text, because it is exactly what the validator
   searches.
3. **Draft concepts.** Each concept gets 2–5 key points in your own words, and
   each key point gets a `start` and an `end` of 2–6 words copied exactly from
   the source. Avoid formulas, which extract as raw notation such as
   `\(b_{1}\)`. In PDFs, also avoid words containing "fi", "fl" or "ff":
   PDF.js drops those ligatures.
4. **Validate:** `npm run packs:check -- <id>`. Fix every error. The usual one
   is a start phrase that appears more than once on the page; lengthen it until
   it is unique. The passage ends at the *first* place the end words appear
   after the start, so make the end words distinctive too.
5. **Set `status: "provisional"`** once it passes with the network on.
6. **Plant errors.** Write `plants/<id>.json`: one deliberately wrong copy of a
   real key point for each kind of corruption (`negation`, `overstatement`,
   `wrong_number_or_direction`, `unsupported_addition`,
   `causal_from_association`). Every misconception's claim is planted
   automatically on top.
7. **Machine check.** Run `npm run packs:check -- <id> --judge-packet`. Give a
   judge in a fresh context *only* the packet it writes, and follow
   `PRD-reference-packs.md` § The machine check. Then run
   `npm run packs:check -- <id> --record-judgement <verdicts.json>`.
   - Any real item that is not `supported` is listed. Widen its anchor if the
     source supports the whole claim; otherwise trim the claim. Then rebuild
     the packet and judge again.
   - A planted error judged `supported` fails the run. Change the judge's
     instructions and their version before re-running.
   - A full pass writes the record and sets `machine-checked`.
8. **Audit (one pack in five).** Travis reads five items beside their
   passages. If he agrees, record the review with `agreedWithJudge: true` and
   set `approved`. If he disagrees, the pack goes back to `provisional`.

Editing any key point or misconception after a machine check makes the
recorded fingerprint stop matching. The offline tests then fail until the pack
is set back to `provisional` and judged again.

`npm test` checks every pack here against the offline rules, so CI catches a
broken file. It cannot check anchors (no network); run `packs:check` whenever a
pack or its sources change.

## Packs

| Pack | Status | Concepts | Sources |
|---|---|---|---|
| `linear-regression` 2.1.0 | machine-checked (Opus 5.5, 2026-10-20: 77/77 supported, 14/14 planted errors caught) | 28 | Penn State STAT 501 (11 lessons), scikit-learn (4 guides), ISLR slides (2), CS229 notes |
| `ab-testing` 1.0.0 | provisional | 18 | Penn State STAT 200 (4 lessons), STAT 500 (1), STAT 509 (4), NIST/SEMATECH e-Handbook (1), Microsoft Experimentation Platform (3 articles), Evan Miller, ASA p-value statement (PDF) |
