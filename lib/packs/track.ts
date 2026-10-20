// ── A pack becomes a board ──────────────────────────────────────────────────
// Turns a reference pack's cards (spec v1.2) into the milestone rows of a
// track. Deterministic: no model chooses or orders anything, so every learner
// on a course gets the same board, and every card traces to the pack.
// See PRD-narrow-learn.md, row 2.
//
// Pure: no I/O, no `server-only`.

import type { ReferencePack } from "@/types/pack";
import type { KanbanColumn, LearningPoint } from "@/types";

/**
 * A concept id that names its pack, e.g. `linear-regression:least_squares`.
 * Stored on `milestones.concept_ids` (migration 060), which a learner's own
 * session cannot write. Grounding keys off it, never off
 * `learning_goals.pack_id`, which a learner can write.
 */
export function qualifiedConceptId(packId: string, conceptId: string): string {
  return `${packId}:${conceptId}`;
}

export function parseQualifiedConceptId(value: string): { packId: string; conceptId: string } | null {
  const at = value.indexOf(":");
  if (at <= 0 || at === value.length - 1) return null;
  return { packId: value.slice(0, at), conceptId: value.slice(at + 1) };
}

/** One milestone row, minus `track_id`, which the writer adds. */
export interface PackMilestoneRow {
  title:           string;
  summary:         string;
  concept_ids:     string[];
  learning_points: LearningPoint[];
  kanban_column:   KanbanColumn;
  position:        number;
}

export interface PackTrack {
  trackTitle: string;
  rows:       PackMilestoneRow[];
}

/**
 * The board for a pack. The first card starts in Learn so the learner has
 * somewhere to begin; the rest wait in Backlog, in the pack's teaching order.
 *
 * Each card's checklist is its concepts' key points, in order. A point's id
 * is `conceptId:n` (n from 1), the same reference the machine check and the
 * reviewer use, so a ticked point names the exact source-checked statement.
 */
export function packTrack(pack: ReferencePack): PackTrack {
  const cards    = pack.cards ?? [];
  const concepts = new Map(pack.concepts.map(c => [c.id, c]));

  const rows = cards.map((card, position): PackMilestoneRow => {
    const onCard = card.conceptIds.flatMap(id => {
      const concept = concepts.get(id);
      return concept ? [concept] : [];
    });
    return {
      title:           card.title,
      summary:         onCard.map(c => c.outcome).join(" "),
      concept_ids:     onCard.map(c => qualifiedConceptId(pack.id, c.id)),
      learning_points: onCard.flatMap(c => c.keyPoints.map((k, i) => ({ id: `${c.id}:${i + 1}`, text: k.text }))),
      kanban_column:   position === 0 ? "learn" : "backlog",
      position,
    };
  });

  return { trackTitle: pack.subject, rows };
}
