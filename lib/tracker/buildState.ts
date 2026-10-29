import { type TrackStatus } from "@/types";

// How long a build may sit at 'pending' before we stop believing in it.
// `after()` work can be killed by the platform without ever writing a final
// status, so 'pending' is not self-limiting — something has to call it.
// Five minutes is comfortably past the observed 30-90s build.
export const STALL_MS = 5 * 60 * 1000;

// What the learner is actually looking at. Distinct from TrackStatus because
// 'pending' means two different things depending on how long it has been
// pending, and because only this vocabulary answers "can they retry?".
export type BuildState =
  | "ready"
  | "building"
  | "stalled"
  | "failed"
  | "awaiting_approval";

/**
 * Resolve a goal's stored status into what the UI should say about it.
 *
 * `startedAtIso` should be `track_started_at ?? created_at` — the fallback
 * covers rows written before migration 046. A null/unparseable timestamp is
 * treated as "just started" rather than "stalled": guessing stalled would
 * offer a retry over a build that may still be running, and running it twice
 * costs a second Sonnet call.
 */
export function buildState(
  status:       TrackStatus,
  startedAtIso: string | null | undefined,
  now:          number,
): BuildState {
  if (status !== "pending") return status;

  if (!startedAtIso) return "building";
  const startedAt = new Date(startedAtIso).getTime();
  if (Number.isNaN(startedAt)) return "building";

  return now - startedAt > STALL_MS ? "stalled" : "building";
}

/**
 * Retry is offered exactly where refreshing cannot help. 'building' still
 * might finish on its own; 'ready' has nothing to fix; 'awaiting_approval'
 * needs the learner to approve a topic, not to rebuild.
 */
export function canRetry(state: BuildState): boolean {
  return state === "failed" || state === "stalled";
}

/**
 * Whether to offer Rebuild at all. Since narrow Learn PR D only a course can
 * be rebuilt: an earlier topic would need the retired open-topic build, so the
 * retry route refuses one before it checks anything else. The goal card and
 * the track page both ask this, so neither offers what the server refuses.
 */
export function canRebuild(state: BuildState, isCourse: boolean): boolean {
  return isCourse && canRetry(state);
}

/**
 * What a library card shows, from the stored status plus two things only the
 * card knows: whether it has just asked for a rebuild, and whether its stall
 * timer has fired. The card watches the build for exactly as long as this
 * says "building", so it must never read a settled status as running.
 *
 * The stored status is checked before the stall flag. The flag is set by a
 * timer while the status was 'pending', and the list can learn 'ready'
 * afterwards; a card that held on to "stalled" then would offer a rebuild the
 * server refuses.
 */
export function cardBuildState(
  trackStatus: TrackStatus,
  rebuilding:  boolean,
  stalled:     boolean,
): BuildState {
  if (rebuilding) return "building";
  if (trackStatus !== "pending") return trackStatus;
  return stalled ? "stalled" : "building";
}

/**
 * Server-side guard for the retry route. Takes the raw row values so the
 * route does not have to duplicate the fallback rule above.
 */
export function isRetryable(
  status:       TrackStatus,
  startedAtIso: string | null | undefined,
  createdAtIso: string,
  now:          number,
): boolean {
  return canRetry(buildState(status, startedAtIso ?? createdAtIso, now));
}

// What the track page should render. A goal can be 'ready' and still have no
// usable board: legacy goals predate track linking, and a track whose
// milestone insert failed under the old unchecked code is 'ready' with an
// empty board. Both are broken, not building.
export type TrackViewState = "board" | "building" | "broken";

export function trackViewState(
  state:          BuildState,
  hasTrack:       boolean,
  milestoneCount: number,
): TrackViewState {
  if (hasTrack && milestoneCount > 0) return "board";
  if (state === "building") return "building";
  return "broken";
}

// Why a retry was refused, so the route can say something true rather than a
// generic 409. Shared with the UI so the button is offered exactly where the
// server would accept it.
export type RetryVerdict =
  | "allow"
  | "still-building"
  | "needs-approval"
  | "nothing-wrong"
  | "rebuild-limit";

/**
 * How many times one goal may be generated, in total, ever.
 *
 * Retry is already restricted to failed and stalled states and gated on the
 * learner's budget, but neither bounds ATTEMPTS. A repeatedly-stalling build is
 * exactly the situation where someone clicks rebuild over and over, and each
 * click is two Sonnet calls. The usage gate is measured in tokens, so it stops
 * a learner who has spent a lot on real study long before it stops one whose
 * only spend is a loop on a broken goal.
 *
 * Five is the initial build plus four rebuilds. A build that is going to
 * succeed almost always does so on the first retry; by the fifth attempt the
 * evidence says something about this goal is wrong, and the honest answer is
 * to say so rather than to keep charging for the same failure.
 *
 * Counted from `track_generations`, which has one row per generation call
 * including the failures \u2014 so it is a count of money actually spent, not of
 * buttons pressed. Goals built before migration 048 have no rows and therefore
 * a full allowance, which is the safe direction to be wrong in.
 */
export const MAX_BUILDS_PER_GOAL = 5;

export function retryVerdict(
  state:          BuildState,
  hasUsableTrack: boolean,
  buildCount    = 0,
): RetryVerdict {
  if (state === "building")          return "still-building";
  if (state === "awaiting_approval") return "needs-approval";

  // 'ready' is only genuinely fine if there is a board behind it. This branch
  // is the one that guards learner data: a retry deletes the track row, and
  // the diary and point history cascade off it, so answering "allow" for a
  // healthy track would destroy work the learner cannot get back. The
  // fallthrough is safe only because an empty board has nothing to lose.
  const brokenEnoughToRebuild =
    state === "failed" || state === "stalled" || !hasUsableTrack;

  if (!brokenEnoughToRebuild) return "nothing-wrong";

  // Checked LAST among the refusals, so a learner at the ceiling is told the
  // most specific true thing. Telling someone with a healthy track that they
  // have rebuilt too often would be a worse answer than "nothing is wrong".
  if (buildCount >= MAX_BUILDS_PER_GOAL) return "rebuild-limit";

  return "allow";
}
