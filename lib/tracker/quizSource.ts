/**
 * Pure helpers for building a review quiz that can only ask what the learner's
 * own notes actually support.
 *
 * The old quiz asked for exactly 5 questions regardless of how much material
 * existed. A card whose diary held four sentences still had to yield five
 * "conceptual understanding" questions, so the model filled the gap from
 * general knowledge and the learner was tested on things they never covered.
 *
 * Two rules fix that, and both live here so they are testable without an API:
 *   1. The question count is derived from how much material there is, not fixed.
 *   2. Every question must quote the note that supports it, and the quote is
 *      verified against the source text — a question that cannot be traced back
 *      is dropped rather than shown.
 */

import type { CoveredPoint } from "@/types";

export interface DiaryEntry {
  title:    string | null;
  body:     string | null;
  /** What the session established, when the entry has it (migration 035 on). */
  covered?: CoveredPoint[] | null;
}

/**
 * The text a quiz may be built from for one entry.
 *
 * `covered` wins outright when present, and `body` is then excluded rather than
 * appended: the body narrates the shape of the conversation ("the student
 * explored dot products"), so leaving it in would let a question be "grounded"
 * in a sentence that records only that a subject came up. Older entries have no
 * `covered` and fall back to the narrative — the best material they have.
 */
export function entryMaterial(entry: DiaryEntry): string {
  if (entry.covered?.length) {
    return entry.covered
      .map(c => `${c.point}: ${c.detail}`)
      .join("\n");
  }
  return entry.body ?? "";
}

export interface GeneratedQuestion {
  question:     string;
  options:      string[];
  correctIndex: number;
  explanation:  string;
  /** Verbatim span from the learner's notes that supports the answer. */
  source:       string;
  /**
   * On a course card, the syllabus key point this question tests
   * (`conceptId:n`, lib/packs/grounding.ts). Absent on any other card.
   */
  keyPoint?:    string;
}

export const MIN_QUESTIONS = 2;
export const MAX_QUESTIONS = 5;

/**
 * Roughly how much prose it takes to support one honest question. Tuned against
 * a real thin card: a 961-character narrative summary yields 2 questions, which
 * is about what four sentences of notes can genuinely carry.
 */
export const CHARS_PER_QUESTION = 450;

/** Per-entry cap on what we send to the model. Generous — entries are prose. */
export const MAX_ENTRY_CHARS = 6000;

/** A quote shorter than this is too generic to prove anything. */
export const MIN_SOURCE_CHARS = 15;

/** Renders the entries as the prompt sees them, and as grounding is checked against. */
export function buildEntriesText(entries: DiaryEntry[]): string {
  return entries
    .map((e, i) => {
      const title = e.title ? ` — ${e.title}` : "";
      return `Note ${i + 1}${title}:\n${entryMaterial(e).slice(0, MAX_ENTRY_CHARS)}`;
    })
    .join("\n\n---\n\n");
}

/** Total characters of real material, ignoring the scaffolding around it. */
export function sourceCharCount(entries: DiaryEntry[]): number {
  return entries.reduce(
    (sum, e) => sum + (e.title?.length ?? 0) + Math.min(entryMaterial(e).length, MAX_ENTRY_CHARS),
    0
  );
}

/**
 * How many questions this much material can honestly support, clamped to
 * [MIN_QUESTIONS, MAX_QUESTIONS]. Callers must still handle the case where the
 * model grounds fewer than the target.
 */
export function questionTarget(chars: number): number {
  const raw = Math.round(chars / CHARS_PER_QUESTION);
  return Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, raw));
}

/**
 * Collapses a string to comparable form: lowercase, punctuation and whitespace
 * flattened to single spaces. Lets a quote match its source across the
 * curly-quote, line-break and spacing differences a model introduces when it
 * copies text.
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True when `source` is a long-enough verbatim span of the notes. */
export function isGrounded(source: string, normalizedEntries: string): boolean {
  const needle = normalizeForMatch(source ?? "");
  if (needle.length < MIN_SOURCE_CHARS) return false;
  return normalizedEntries.includes(needle);
}

/** Shape check — the model returns free-form JSON, so nothing is assumed. */
export function isWellFormed(q: unknown): q is GeneratedQuestion {
  if (typeof q !== "object" || q === null) return false;
  const c = q as Record<string, unknown>;
  return (
    typeof c.question     === "string" && c.question.trim().length > 0 &&
    typeof c.explanation  === "string" &&
    typeof c.source       === "string" &&
    Array.isArray(c.options) && c.options.length === 4 &&
    c.options.every(o => typeof o === "string" && o.trim().length > 0) &&
    typeof c.correctIndex === "number" &&
    Number.isInteger(c.correctIndex) && c.correctIndex >= 0 && c.correctIndex <= 3 &&
    (c.keyPoint === undefined || typeof c.keyPoint === "string")
  );
}

/**
 * On a course card, keep only questions that name one of the card's own key
 * points (PRD-narrow-learn.md, row 4). A question that tests nothing on the
 * syllabus, or names a key point the card does not have, is dropped: a quiz on
 * a course card checks the course, not whatever else the notes mention.
 */
export function keepSyllabusQuestions(
  questions: readonly GeneratedQuestion[],
  keyPointRefs: readonly string[],
): { kept: GeneratedQuestion[]; offSyllabus: number } {
  const refs = new Set(keyPointRefs);
  const kept = questions.filter(q => q.keyPoint !== undefined && refs.has(q.keyPoint));
  return { kept, offSyllabus: questions.length - kept.length };
}

export interface GroundingResult {
  kept:      GeneratedQuestion[];
  malformed: number;
  ungrounded: number;
}

/**
 * Keeps only questions that are well-formed *and* quote the notes. Trims to
 * `limit` so a model that overshoots the target cannot widen the quiz.
 */
export function keepGroundedQuestions(
  questions: unknown,
  entriesText: string,
  limit: number
): GroundingResult {
  if (!Array.isArray(questions)) return { kept: [], malformed: 0, ungrounded: 0 };

  const normalized = normalizeForMatch(entriesText);
  const kept: GeneratedQuestion[] = [];
  let malformed  = 0;
  let ungrounded = 0;

  for (const q of questions) {
    if (!isWellFormed(q)) { malformed++; continue; }
    if (!isGrounded(q.source, normalized)) { ungrounded++; continue; }
    if (kept.length < limit) kept.push(q);
  }

  return { kept, malformed, ungrounded };
}
