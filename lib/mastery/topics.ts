// ── Mastery's checklist: the topics, the score and the feedback ─────────────
// A session is judged by which topics the learner covered, so everything that
// follows the check is arithmetic: the same ticks always give the same score,
// the same pass and the same words. No model is involved past the check itself
// (lib/mastery/turnCheck.ts).
//
// Pure: no I/O, no `server-only`. A course card's pack is bundled, so the page
// and the route both build the list from here and cannot disagree.

import type { LearningPoint } from "@/types";
import {
  cardGrounding, GROUNDING_REFUSAL_MESSAGE, type CardGround, type GroundedMisconception,
} from "@/lib/packs/grounding";
import { MASTERY_FEEDBACK_MAX_CHARS, MASTERY_SCORE_MAX, MASTERY_SCORE_MIN } from "./outcome";

/** What the browser receives: a name, never the statement behind it. */
export interface MasteryTopic {
  ref:   string;
  label: string;
}

/** What the check reads. `point` is what the learner has to show. */
export interface CheckableTopic extends MasteryTopic {
  point: string;
}

export type CardTopics =
  | { kind: "ok"; topics: CheckableTopic[]; ground: CardGround | null }
  /** A course card whose pack can't be taught from, in its own words. */
  | { kind: "refused"; message: string }
  /** An older card whose checklist has not been built yet. The coverage route builds it. */
  | { kind: "missing" };

function courseTopics(ground: CardGround): CheckableTopic[] {
  return ground.concepts.flatMap(c => c.keyPoints.map(k => ({ ref: k.ref, label: k.label, point: k.text })));
}

/** `learning_points` is learner-writable JSON, so nothing about its shape is assumed. */
function learningPointTopics(points: unknown): CheckableTopic[] {
  if (!Array.isArray(points)) return [];
  return (points as Array<Partial<LearningPoint> | null>).flatMap(p =>
    typeof p?.id === "string" && typeof p.text === "string" && p.text.trim()
      ? [{ ref: p.id, label: p.text.trim(), point: p.text.trim() }]
      : [],
  );
}

/**
 * The card's topics. On a course card they come from its source-checked pack,
 * never `learning_points`; on an older card, from the checklist it already has.
 */
export function cardTopics(conceptIds: readonly string[] | null | undefined, learningPoints: unknown): CardTopics {
  const grounding = cardGrounding(conceptIds);
  if (grounding.kind === "refused") return { kind: "refused", message: GROUNDING_REFUSAL_MESSAGE[grounding.reason] };
  if (grounding.kind === "ok") return { kind: "ok", topics: courseTopics(grounding.ground), ground: grounding.ground };
  const topics = learningPointTopics(learningPoints);
  return topics.length > 0 ? { kind: "ok", topics, ground: null } : { kind: "missing" };
}

/** Labels only: the statements stay on the server. */
export function topicsForBrowser(topics: readonly CheckableTopic[]): MasteryTopic[] {
  return topics.map(({ ref, label }) => ({ ref, label }));
}

/** The card's wrong beliefs, or none on an older card. */
export function cardMisconceptions(ground: CardGround | null): GroundedMisconception[] {
  return ground ? ground.concepts.flatMap(c => c.misconceptions) : [];
}

/**
 * The score is the share of topics covered, out of 10 and rounded down, so a 7
 * always means at least 70%. It never goes below the scale's floor: a session
 * that covered nothing still scores the lowest mark, not an invalid zero.
 */
export function coverageScore(covered: number, total: number): number {
  if (total <= 0) return MASTERY_SCORE_MIN;
  const share = Math.floor((MASTERY_SCORE_MAX * Math.min(covered, total)) / total);
  return Math.max(MASTERY_SCORE_MIN, share);
}

/** What the result screen says about coverage. The same ticks always give the same words. */
export interface CoverageSummary {
  headline: string;
  /** Labels of the topics left open, in the card's order. */
  missed:   string[];
}

export function coverageSummary(topics: readonly MasteryTopic[], covered: readonly string[]): CoverageSummary {
  const done   = new Set(covered);
  const missed = topics.filter(t => !done.has(t.ref)).map(t => t.label);
  const total  = topics.length;
  const headline = missed.length > 0 ? `You covered ${total - missed.length} of ${total} ${total === 1 ? "topic" : "topics"}.`
    : total === 1                    ? "You covered the topic."
    :                                  `You covered all ${total} topics.`;
  return { headline, missed };
}

/**
 * What the card keeps, for the summary it can generate later. That reader has no
 * panel of ticks beside it, so unlike the result screen this spells out what was
 * missed.
 */
export function coverageFeedback(
  topics: readonly MasteryTopic[], covered: readonly string[], corrections: readonly string[] = [],
): string {
  const { headline, missed } = coverageSummary(topics, covered);
  const coverage = missed.length > 0 ? `${headline} Not covered: ${missed.join("; ")}.` : headline;
  return [coverage, ...corrections].join("\n\n").slice(0, MASTERY_FEEDBACK_MAX_CHARS);
}
