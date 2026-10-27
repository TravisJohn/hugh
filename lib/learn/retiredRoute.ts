import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { recordOperation } from "@/lib/observability/record";
import { CHOOSE_COURSE_HREF } from "./earlierTopic";

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

/**
 * The goals route is not retired (it starts courses), but a typed topic sent
 * to it is the same closed path, so it is counted under this name.
 */
export const TOPIC_GOAL_ROUTE = "dashboard/goals:topic";

/**
 * Saving an Ask session that names no card used to add a new, ungrounded card
 * to the goal's track. Ask always names a card since PR D, so that branch is
 * the closed path too, counted under this name.
 */
export const CARDLESS_SAVE_ROUTE = "learn/save-summary:no-card";

/** What save-summary says to a session that names no card. */
export const CARDLESS_SAVE_MESSAGE =
  "Hugh saves each conversation to the card it was about. Open a card on your board and ask from there.";

export const RETIRED_ROUTE_MESSAGE =
  "Hugh no longer builds a track from a typed topic or a document. " +
  "Choose one of the source-checked courses instead.";

/** What the goals route says to a typed topic: a course is the only way in. */
export const TOPIC_GOAL_MESSAGE =
  "Hugh now starts every track from a source-checked course, not a typed topic. " +
  "Choose a course from the catalog instead.";

/**
 * Record a signed-in call to the closed open-topic path. Awaited by both
 * callers, because a lost row reads as "nothing uses this" (see the top of
 * this file).
 */
export async function recordRetiredCall(
  userId: string,
  route:  RetiredRoute | typeof TOPIC_GOAL_ROUTE | typeof CARDLESS_SAVE_ROUTE,
): Promise<void> {
  await recordOperation({
    userId,
    operation: "learn.retired",
    outcome:   "refused",
    detail:    { route },
  });
}

export async function retiredRouteResponse(
  request: NextRequest,
  route:   RetiredRoute,
): Promise<NextResponse> {
  const userId = await getAuthenticatedUserId(request);
  if (userId) await recordRetiredCall(userId, route);
  return NextResponse.json(
    { error: RETIRED_ROUTE_MESSAGE, chooseCourse: CHOOSE_COURSE_HREF },
    { status: 410 },
  );
}
