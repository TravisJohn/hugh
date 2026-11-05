// ── Mastery: what the server records after scoring ──────────────────────────
// The browser used to write mastery results itself, through the milestone
// PATCH route, so a learner could mark a card mastered without passing.
// Migration 058 closes the columns to learners; the mastery session route now
// records the result itself when a session finishes, by these rules.
//
// Pure: no I/O. The rules match what the browser did before, unchanged:
//   - a first pass validates the card and records the score and feedback;
//   - a practice run on a mastered card records the latest score (even a
//     lower one) and never revokes mastery;
//   - a first attempt that does not pass records nothing.

export const MASTERY_PASS_SCORE = 7;
export const MASTERY_SCORE_MIN  = 1;
export const MASTERY_SCORE_MAX  = 10;
/** The list of what was missed, built by the server; this only stops a long one landing in the row. */
export const MASTERY_FEEDBACK_MAX_CHARS = 2000;

export interface MasteryEvaluation {
  score:    number;
  feedback: string;
  /**
   * A course card's listed wrong beliefs the learner stated and left
   * uncorrected, by ref (`conceptId:mn`). Any one of them means the card is
   * not mastered, whatever the score (PRD-narrow-learn.md, row 4). Empty on
   * every other card.
   */
  misconceptionsHeld?: string[];
}

export interface MasteryWrite {
  mastery_validated?: true;
  mastery_score:      number;
  mastery_feedback:   string;
}

/**
 * What happened to the result, as the session route reports it to the page:
 * written, deliberately not written (a first attempt that did not pass), or
 * scored but not saved. The last needs its own message, because the learner's
 * score is real even though it was not recorded.
 */
export type MasteryRecord = "saved" | "skipped" | "failed";

export interface MasteryOutcome {
  /** Decided here, from the score. The model's own "passed" is not trusted. */
  passed: boolean;
  /** The columns to write, or null when nothing should be recorded. */
  write:  MasteryWrite | null;
}

export function masteryOutcome(evaluation: MasteryEvaluation, alreadyMastered: boolean): MasteryOutcome {
  const passed = evaluation.score >= MASTERY_PASS_SCORE && (evaluation.misconceptionsHeld ?? []).length === 0;
  const recorded = { mastery_score: evaluation.score, mastery_feedback: evaluation.feedback };
  if (alreadyMastered) return { passed, write: recorded };
  if (passed) return { passed, write: { mastery_validated: true, ...recorded } };
  return { passed, write: null };
}
