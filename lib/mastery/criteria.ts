// ── Mastery criteria (pure, framework-agnostic, unit-tested) ────────────────
// The AUTHORITATIVE assessment rubric is built from the card itself — the
// milestone's learning points (the concepts that must be understood) and its
// summary. Diary notes are prepared separately as SUPPORTING learner context and
// must never replace or weaken these criteria.

import type { LearningPoint } from "@/types";

// Fixed skill dimensions every mastery conversation probes. These are the
// "can the learner…" checks the coach pushes on and the evaluator scores.
export const MASTERY_RUBRIC: readonly string[] = [
  "Explain the concept accurately in their own words",
  "Use correct terminology",
  "Apply it to a new, unseen scenario",
  "Distinguish it from related concepts",
  "Explain the trade-offs involved",
  "Identify limitations or risks",
];

// Score at or above which mastery is considered demonstrated (back-compat with
// the existing mastery_validated gate).
export const PASS_THRESHOLD = 7;

/** A wrong belief the learner must not leave standing (narrow Learn, PRD row 4). */
export interface CriteriaMisconception {
  ref:        string;
  claim:      string;
  correction: string;
}

/**
 * A course card's syllabus, as plain data (lib/packs/grounding.ts supplies it;
 * this module does not import packs). When given, it is the whole authority.
 */
export interface CriteriaSyllabus {
  keyPoints:      string[];
  misconceptions: CriteriaMisconception[];
}

export interface MasteryCriteria {
  topicTitle:     string;
  /** Authoritative: the course's key points, or else the card's learning points. */
  concepts:       string[];
  summary:        string;     // authoritative — the card's own summary
  rubric:         readonly string[];
  passThreshold:  number;
  /** A course card's listed wrong beliefs. Empty on any other card. */
  misconceptions: CriteriaMisconception[];
}

export function buildCriteria(
  card: {
    title:          string;
    summary?:       string | null;
    learningPoints?: LearningPoint[] | null;
  },
  syllabus?: CriteriaSyllabus,
): MasteryCriteria {
  // A course card is judged against its source-checked key points ONLY.
  // `learning_points` stays learner-writable (058 grants it for the coverage
  // checklist), so it must never be what a course card is scored against.
  const concepts = syllabus
    ? syllabus.keyPoints.map(t => t.trim()).filter(t => t.length > 0)
    : (card.learningPoints ?? [])
        .map((p) => p.text?.trim())
        .filter((t): t is string => !!t);

  return {
    topicTitle:     card.title,
    concepts,
    summary:        (card.summary ?? "").trim(),
    rubric:         MASTERY_RUBRIC,
    passThreshold:  PASS_THRESHOLD,
    misconceptions: syllabus?.misconceptions ?? [],
  };
}

// Renders the authoritative criteria as a prompt block. Used by BOTH the coach
// instructions and the evaluator so they assess the same thing.
export function renderCriteriaForPrompt(c: MasteryCriteria): string {
  const conceptLines = c.concepts.length
    ? c.concepts.map((x) => `- ${x}`).join("\n")
    : "- (No explicit learning points on this card; assess general understanding of the topic.)";

  const summaryBlock = c.summary
    ? `\nCard summary (authoritative):\n${c.summary}\n`
    : "";

  const misconceptionBlock = c.misconceptions.length
    ? [
        ``,
        `Known wrong beliefs (if the learner states one and does not correct it, they have not mastered this card):`,
        ...c.misconceptions.map((m) => `- [${m.ref}] ${m.claim}\n  Correction: ${m.correction}`),
      ].join("\n")
    : "";

  return [
    `Topic: "${c.topicTitle}"`,
    ``,
    `Key concepts the learner must demonstrate (authoritative — from the card):`,
    conceptLines,
    summaryBlock,
    `They should be able to:`,
    c.rubric.map((r) => `- ${r}`).join("\n"),
    misconceptionBlock,
  ].join("\n");
}

// Prepares diary notes as SUPPORTING context only. Entries are already scoped to
// the milestone (fetched by milestone_id), so relevance is guaranteed; here we
// just cap total length and label the block so it can't be mistaken for truth.
export function prepareDiaryContext(
  entries: { title?: string | null; body?: string | null }[],
  maxChars: number,
): string {
  // Drop entries with no real content BEFORE labelling, so a blank body doesn't
  // survive as a bare "[Note N]" header.
  const usable = entries.filter(
    (e) => (e.body ?? "").trim().length > 0 || (e.title ?? "").trim().length > 0,
  );
  if (!usable.length) return "";

  const joined = usable
    .map((e, i) => `[Note ${i + 1}]${e.title ? ` ${e.title.trim()}` : ""}\n${(e.body ?? "").trim()}`)
    .join("\n\n");

  if (!joined) return "";

  const capped =
    joined.length > maxChars
      ? `${joined.slice(0, maxChars)}\n…(truncated)`
      : joined;

  return capped;
}
