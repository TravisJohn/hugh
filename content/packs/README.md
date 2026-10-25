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

9. **Lay out the cards (spec v1.2), before the catalog.** Add `cards`: 8–14
   cards in teaching order, each `{ id, title, conceptIds }` with 1–4
   concepts. Every live concept goes on exactly one card, and no card may
   teach a concept before one of its prerequisites (the same card is fine).
   Travis approves the order. Cards are not judged, so adding them does not
   disturb the machine check. To list the pack, add it to
   `lib/packs/catalog.ts` and record its ids in `ids/<id>.json`. From then on
   an id is permanent: retire a concept (`"retired": true`, off every card)
   instead of deleting it, because learners' boards store these ids.

Editing any key point or misconception after a machine check makes the
recorded fingerprint stop matching. The offline tests then fail until the pack
is set back to `provisional` and judged again.

`npm test` checks every pack here against the offline rules, so CI catches a
broken file. It cannot check anchors (no network); run `packs:check` whenever a
pack or its sources change.

## Packs

| Pack | Status | Concepts | Sources |
|---|---|---|---|
| `linear-regression` 2.2.0 | machine-checked (Opus 5.5, 2026-10-20: 77/77 supported, 14/14 planted errors caught); 12 cards; **in the catalog** | 28 | Penn State STAT 501 (11 lessons), scikit-learn (4 guides), ISLR slides (2), CS229 notes |
| `ab-testing` 1.2.0 | machine-checked (Opus 5.5, 2026-10-20: 79/79 supported, 14/14 planted errors caught); 9 cards; **in the catalog** | 18 | Penn State STAT 200 (4 lessons), STAT 500 (1), STAT 509 (4), NIST/SEMATECH e-Handbook (1), Microsoft Experimentation Platform (3 articles), Evan Miller, ASA p-value statement (PDF) |
| `time-series-forecasting` 1.0.0 | machine-checked (Opus 5.5, 2026-10-20: 129/129 supported, 19/19 planted errors caught); 13 cards; **in the catalog** | 27 | Forecasting: Principles and Practice 3rd ed. (7 chapters), Penn State STAT 510 (3 lessons), NIST/SEMATECH e-Handbook (4 pages) |
| `clustering` 1.0.0 | machine-checked (Opus 5.5, 2026-10-21: 116/116 supported, 14/14 planted errors caught); 10 cards (approved by Travis, PR #33); **in the catalog** | 24 | scikit-learn (6 pages), Penn State STAT 505 (2 lessons), STAT 508 (2), Google Machine Learning clustering course (8 pages) |
| `decision-trees` 1.0.0 | machine-checked (Opus 5.5, 2026-10-21: 135/135 supported, 18/18 planted errors caught); 12 cards (approved by Claude for Travis, pending his review); **in the catalog** | 27 | scikit-learn developers, Penn State Department of Statistics, Google for Developers, Decision Forests course (19 pages) |
| `bayesian-inference` 1.0.0 | machine-checked (Opus 5.5, 2026-10-21: 129/129 supported, 18/18 planted errors caught); 13 cards (approved by Claude for Travis, pending his review); **in the catalog** | 25 | Penn State Statistics, Bayes Rules! (Johnson, Ott and Dogucu), Statistical Thinking for the 21st Century (Poldrack), NIST/SEMATECH, Evan Miller (16 pages) |
| `outlier-detection` 1.0.0 | machine-checked (Opus 5.5, 2026-10-21: 117/117 supported, 14/14 planted errors caught); 12 cards (approved by Claude for Travis, pending his review); **in the catalog** | 26 | NIST/SEMATECH e-Handbook, scikit-learn, Penn State Statistics (14 pages) |
| `neural-networks` 1.0.0 | machine-checked (Opus 5.5, 2026-10-22: 125/125 supported, 19/19 planted errors caught, judge run 2); 11 cards (order approved by Claude on Travis's instruction); **in the catalog** | 25 | Google Machine Learning Crash Course (13 pages) and Decision Forests course (1), scikit-learn MLP guide, Dive into Deep Learning (10 sections) |
| `classification-metrics` 1.0.0 | machine-checked (Opus 5.5, 2026-10-22: 119/119 supported, 15/15 planted errors caught, judge run 2); 12 cards (order approved by Claude on Travis's instruction); **in the catalog** | 28 | Google Machine Learning Crash Course (10 pages), scikit-learn (5 pages), Penn State STAT 501 and STAT 504 (17 pages in all) |
| `descriptive-statistics` 1.0.0 | machine-checked (Opus 5.5, 2026-10-22: 113/113 supported, 13/13 planted errors caught); 13 cards (approved by Travis); **in the catalog** | 27 | Penn State Department of Statistics, NIST/SEMATECH, OpenIntro (Çetinkaya-Rundel and Hardin), Google for Developers (16 pages) |
| `probability-distributions` 1.0.0 | machine-checked (Opus 5.5, 2026-10-22: 119/119 supported, 15/15 planted errors caught); 13 cards (approved by Travis); **in the catalog** | 28 | Penn State Department of Statistics, NIST/SEMATECH, OpenIntro (Çetinkaya-Rundel and Hardin) (25 pages) |
| `sampling-and-surveys` 1.0.0 | machine-checked (Opus 5.5, 2026-10-23: 124/124 supported, 17/17 planted errors caught); 13 cards (approved by Travis); **in the catalog** | 28 | Penn State Department of Statistics, OpenIntro (Mine Çetinkaya-Rundel and Johanna Hardin), Pew Research Center (15 pages) |
| `sampling-distributions` 1.0.0 | machine-checked (Opus 5.5, 2026-10-23: 124/124 supported, 15/15 planted errors caught); 12 cards (approved by Travis); **in the catalog** | 27 | Penn State Department of Statistics, OpenIntro (Cetinkaya-Rundel and Hardin), NIST/SEMATECH e-Handbook of Statistical Methods (15 pages) |
| `hypothesis-testing` 1.0.0 | machine-checked (Opus 5.5, 2026-10-23: 97/97 supported, 12/12 planted errors caught); 11 cards (approved by Travis); **in the catalog** | 23 | Penn State Department of Statistics, OpenIntro (Cetinkaya-Rundel and Hardin), NIST/SEMATECH e-Handbook of Statistical Methods (12 pages) |
| `comparing-groups` 1.0.0 | machine-checked (Opus 5.5, 2026-10-23: 75/75 supported, 11/11 planted errors caught); 10 cards (approved by Travis); **in the catalog** | 17 | Penn State Department of Statistics, OpenIntro (Cetinkaya-Rundel and Hardin), NIST/SEMATECH e-Handbook of Statistical Methods, Russell A. Poldrack, Statistical Thinking for the 21st Century (16 pages) |
| `categorical-data` 1.0.0 | machine-checked (Opus 5.5, 2026-10-23: 67/67 supported, 11/11 planted errors caught); 10 cards (approved by Travis); **in the catalog** | 16 | Penn State Department of Statistics, OpenIntro (Cetinkaya-Rundel and Hardin), Russell A. Poldrack, Statistical Thinking for the 21st Century, NIST/SEMATECH e-Handbook of Statistical Methods (10 pages) |
| `dimensionality-reduction` 1.0.0 | machine-checked (Opus 5.5, 2026-10-25: 84/84 supported, 12/12 planted errors caught, judge run 4); 9 cards (approved by Claude for Travis, pending his review); **in the catalog** | 19 | Penn State Department of Statistics, NIST/SEMATECH e-Handbook of Statistical Methods, scikit-learn developers, Google for Developers (9 pages) |
| `causal-inference` 1.0.0 | machine-checked (Opus 5.5, 2026-10-25: 78/78 supported, 12/12 planted errors caught, judge run 2); 9 cards (approved by Claude for Travis, pending his review); **in the catalog** | 18 | Matheus Facure, Causal Inference for the Brave and True; Nick Huntington-Klein, The Effect; OpenIntro (Cetinkaya-Rundel and Hardin) (10 pages) |
