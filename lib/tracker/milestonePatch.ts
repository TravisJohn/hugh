// ── What a learner may change on a milestone, and what it resets ───────────
// The milestone PATCH route used to copy review and mastery results straight
// from the request body into the row, so a learner could mark their own cards
// reviewed or mastered. This decides what a request may write instead. Pure.
//
// - Results are never accepted here. The mastery session route records a
//   mastery result after it scores the learner (lib/mastery/outcome.ts), and
//   tracker/review/submit records a review pass after it grades the stored
//   quiz (lib/tracker/reviewGrading.ts).
// - Moving a card into a stage means it has to earn that stage again, so a
//   move into `review` clears review_validated and a move into `done` clears
//   mastery_validated. The server derives those resets; the client no longer
//   sends them.

import type { KanbanColumn } from "@/types";

export const VALID_COLUMNS: readonly KanbanColumn[] = ["backlog", "learn", "review", "done"];

export interface MilestonePatchWrite {
  kanban_column?:     KanbanColumn;
  review_validated?:  false;
  mastery_validated?: false;
}

export type MilestonePatch =
  | { ok: true;  write: MilestonePatchWrite }
  | { ok: false; error: string };

function isColumn(v: unknown): v is KanbanColumn {
  return typeof v === "string" && (VALID_COLUMNS as readonly string[]).includes(v);
}

export function buildMilestonePatch(body: unknown): MilestonePatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body" };
  }
  const b = body as Record<string, unknown>;

  // Older clients sent `masteryValidated: false` with a move into `done`. That
  // reset is derived now, so a false is ignored; anything else is a result.
  if ("masteryScore" in b || "masteryFeedback" in b || (b.masteryValidated !== undefined && b.masteryValidated !== false)) {
    return { ok: false, error: "Mastery results cannot be set through this route" };
  }

  if (b.column !== undefined) {
    if (!isColumn(b.column)) return { ok: false, error: "Invalid column" };
    // A move with a review result attached could promote a card in one step.
    // Older clients only ever attached `false`, which the move implies anyway.
    if (b.reviewValidated !== undefined && b.reviewValidated !== false) {
      return { ok: false, error: "A review result cannot be sent with a column move" };
    }
    const write: MilestonePatchWrite = { kanban_column: b.column };
    if (b.column === "review") write.review_validated  = false;
    if (b.column === "done")   write.mastery_validated = false;
    return { ok: true, write };
  }

  // On its own, a review flag is a result, and results are the server's.
  if (b.reviewValidated !== undefined) {
    return { ok: false, error: "Review results cannot be set through this route" };
  }

  return { ok: false, error: "No valid fields to update" };
}
