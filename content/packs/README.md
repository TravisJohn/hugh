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
   it is unique.
5. **Set `status: "provisional"`** once it passes with the network on.
6. **Spot-check.** The validator prints five random key points with links that
   open each source scrolled to the passage. If each key point fairly says what
   its passage says, record the review (`reviewedBy`, `reviewedAt`,
   `sampledKeyPoints`) and set `status: "approved"`.

`npm test` checks every pack here against the offline rules, so CI catches a
broken file. It cannot check anchors (no network); run `packs:check` whenever a
pack or its sources change.

## Packs

| Pack | Status | Concepts | Sources |
|---|---|---|---|
| `linear-regression` 2.0.0 | provisional | 28 | Penn State STAT 501 (11 lessons), scikit-learn (4 guides), ISLR slides (2), CS229 notes |
