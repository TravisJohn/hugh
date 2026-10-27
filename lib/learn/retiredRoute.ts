import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { recordOperation } from "@/lib/observability/record";

// Narrow Learn phase 2, PR D: the open-topic path closes. Learners start from
// the course catalog, so these routes no longer read anything or spend
// anything. Each one answers 410 through `retiredRouteResponse`, so the copy
// and the record live here once rather than in four handlers.
//
// The files stay until phase 3 deletes them. That waits for a week in
// production with no `learn.retired` event from real use, which is why
// a signed-in call is recorded and awaited: a lost row would read as "nothing
// uses this" and could delete a route someone still reaches.
//
// `goals/[id]/answers` is deliberately NOT here. It reads and deletes answers
// a learner already gave, and /privacy promises they can do both from the
// card. Nothing new can reach it once refinement is retired (Travis,
// 2026-10-27).

export const RETIRED_ROUTES = [
  "dashboard/classify-topic",
  "dashboard/refine",
  "dashboard/goals/document/extract",
  "dashboard/goals/document/approve",
] as const;

export type RetiredRoute = (typeof RETIRED_ROUTES)[number];

/** Where a caller of a retired route is sent instead. */
export const CHOOSE_COURSE_HREF = "/home/learn";

export const RETIRED_ROUTE_MESSAGE =
  "Hugh no longer builds a track from a typed topic or a document. " +
  "Choose one of the source-checked courses instead.";

export async function retiredRouteResponse(
  request: NextRequest,
  route:   RetiredRoute,
): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId(request);
  if (userId) {
    await recordOperation({
      userId,
      operation: "learn.retired",
      outcome:   "refused",
      detail:    { route },
    });
  }
  return NextResponse.json(
    { error: RETIRED_ROUTE_MESSAGE, chooseCourse: CHOOSE_COURSE_HREF },
    { status: 410 },
  );
}
