import { NextResponse } from "next/server";
import { cardGrounding, groundingRefusal, type GroundingRefusal } from "./grounding";

// The one response a card route sends when a card can't be taught from a
// syllabus: an earlier topic (read-only since narrow Learn PR D), or a course
// card whose pack can't be loaded. The status and copy come from
// `groundingRefusal`, so every surface refuses the same card the same way.

export function groundingRefusalResponse(reason: GroundingRefusal): NextResponse {
  const { status, body } = groundingRefusal(reason);
  return NextResponse.json(body, { status });
}

/** Whether a card is a course card Hugh can teach from its syllabus. */
export function isTeachable(conceptIds: readonly string[] | null | undefined): boolean {
  return cardGrounding(conceptIds).kind === "ok";
}

/**
 * For a route that changes or spends on a card without teaching from it:
 * moving it, writing its diary, or summarising it. Null when the card is a
 * teachable course card; the refusal to send otherwise. Reading and deleting
 * are never routed through this, so an earlier topic stays readable and
 * removable.
 */
export function readOnlyRefusal(conceptIds: readonly string[] | null | undefined): NextResponse | null {
  const grounding = cardGrounding(conceptIds);
  return grounding.kind === "refused" ? groundingRefusalResponse(grounding.reason) : null;
}
