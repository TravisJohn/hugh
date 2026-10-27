import { describe, it, expect } from "vitest";
import {
  buildState,
  canRetry,
  canRebuild,
  cardBuildState,
  isRetryable,
  trackViewState,
  retryVerdict,
  STALL_MS,
  MAX_BUILDS_PER_GOAL,
} from "./buildState";

const NOW = new Date("2026-08-24T12:00:00Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("buildState - 'pending' means two different things", () => {
  it("reads a fresh pending build as building", () => {
    expect(buildState("pending", ago(30_000), NOW)).toBe("building");
  });

  it("reads a pending build older than the stall window as stalled", () => {
    expect(buildState("pending", ago(STALL_MS + 1_000), NOW)).toBe("stalled");
  });

  it("holds at building right up to the boundary", () => {
    // Exactly at the threshold is still building - the comparison is strict,
    // so a build is never declared dead on the tick it might be finishing.
    expect(buildState("pending", ago(STALL_MS), NOW)).toBe("building");
  });

  it("passes every settled status straight through", () => {
    expect(buildState("ready", ago(0), NOW)).toBe("ready");
    expect(buildState("failed", ago(0), NOW)).toBe("failed");
    expect(buildState("awaiting_approval", ago(0), NOW)).toBe("awaiting_approval");
  });
});

describe("buildState - missing or bad timestamps err towards patience", () => {
  it("treats a null start time as building, not stalled", () => {
    // Guessing stalled would offer a retry over a build that may still be
    // running, and a duplicate run costs a second Sonnet call.
    expect(buildState("pending", null, NOW)).toBe("building");
  });

  it("treats an undefined start time as building", () => {
    expect(buildState("pending", undefined, NOW)).toBe("building");
  });

  it("treats an unparseable start time as building", () => {
    expect(buildState("pending", "not a date", NOW)).toBe("building");
  });
});

describe("canRetry - offered only where refreshing cannot help", () => {
  it("allows a retry on failed and stalled", () => {
    expect(canRetry("failed")).toBe(true);
    expect(canRetry("stalled")).toBe(true);
  });

  it("refuses a retry while a build might still finish on its own", () => {
    expect(canRetry("building")).toBe(false);
  });

  it("refuses a retry on a track that is fine", () => {
    expect(canRetry("ready")).toBe(false);
  });

  it("refuses a retry on a goal waiting for the learner to approve a topic", () => {
    // The remedy there is approving, not rebuilding.
    expect(canRetry("awaiting_approval")).toBe(false);
  });
});

describe("isRetryable - the server-side guard", () => {
  it("falls back to created_at for rows written before migration 046", () => {
    expect(isRetryable("pending", null, ago(STALL_MS + 1_000), NOW)).toBe(true);
    expect(isRetryable("pending", null, ago(10_000), NOW)).toBe(false);
  });

  it("prefers track_started_at over created_at once it exists", () => {
    // A retried goal keeps its original created_at. Reading that instead of
    // the new start time is what would mark every retry stalled on arrival.
    expect(isRetryable("pending", ago(5_000), ago(30 * 60 * 1000), NOW)).toBe(false);
  });

  it("always allows a retry on an explicitly failed build", () => {
    expect(isRetryable("failed", ago(1_000), ago(1_000), NOW)).toBe(true);
  });

  it("never allows a retry on a ready track", () => {
    expect(isRetryable("ready", ago(60 * 60 * 1000), ago(60 * 60 * 1000), NOW)).toBe(false);
  });
});

describe("trackViewState - a 'ready' goal can still have no board", () => {
  it("shows the board when a track exists with milestones on it", () => {
    expect(trackViewState("ready", true, 6)).toBe("board");
  });

  it("calls a ready track with zero milestones broken, not building", () => {
    // This is the residue of the unchecked milestone insert: status 'ready',
    // track row present, board empty. Refreshing it forever was the old
    // behaviour.
    expect(trackViewState("ready", true, 0)).toBe("broken");
  });

  it("calls a ready goal with no track at all broken", () => {
    // Legacy goals created before tracks were linked to goals.
    expect(trackViewState("ready", false, 0)).toBe("broken");
  });

  it("shows building only while the build is genuinely in flight", () => {
    expect(trackViewState("building", false, 0)).toBe("building");
    expect(trackViewState("stalled", false, 0)).toBe("broken");
    expect(trackViewState("failed", false, 0)).toBe("broken");
  });

  it("prefers a usable board over any status the goal claims", () => {
    // If the milestones are there, the learner can work - whatever the row says.
    expect(trackViewState("failed", true, 4)).toBe("board");
  });
});

describe("retryVerdict - the button appears exactly where the server would accept it", () => {
  it("allows a rebuild on failed and stalled", () => {
    expect(retryVerdict("failed", false)).toBe("allow");
    expect(retryVerdict("stalled", false)).toBe("allow");
  });

  it("allows a rebuild on a ready goal whose board is unusable", () => {
    expect(retryVerdict("ready", false)).toBe("allow");
  });

  it("refuses while a build is still running, so a stale tab cannot double-spend", () => {
    expect(retryVerdict("building", false)).toBe("still-building");
  });

  it("refuses a goal that needs the learner to approve a topic first", () => {
    expect(retryVerdict("awaiting_approval", false)).toBe("needs-approval");
  });

  it("refuses when there is nothing wrong", () => {
    expect(retryVerdict("ready", true)).toBe("nothing-wrong");
  });
});


// ── The rebuild ceiling (Learn-map X5) ──────────────────────────────────────
//
// Retry was restricted to failed and stalled states and gated on budget, but
// nothing bounded ATTEMPTS - and a repeatedly-stalling build is exactly where
// someone clicks rebuild over and over, two Sonnet calls at a time.

describe("retryVerdict - the rebuild ceiling", () => {
  it("allows a rebuild below the ceiling", () => {
    expect(retryVerdict("failed", false, MAX_BUILDS_PER_GOAL - 1)).toBe("allow");
  });

  it("refuses once the goal has been generated its full allowance", () => {
    expect(retryVerdict("failed", false, MAX_BUILDS_PER_GOAL)).toBe("rebuild-limit");
    expect(retryVerdict("stalled", false, MAX_BUILDS_PER_GOAL + 3)).toBe("rebuild-limit");
  });

  it("defaults to allowing when no count is supplied", () => {
    // The UI calls this without a count, and a goal built before migration 048
    // has no rows to count. Both must behave as they did before the ceiling
    // existed rather than locking anyone out.
    expect(retryVerdict("failed", false)).toBe("allow");
    expect(retryVerdict("stalled", false, 0)).toBe("allow");
  });

  it("still reports a live build as still-building, ceiling or not", () => {
    // Ordering matters: a running build must never be described as a
    // rebuild-limit, because the learner's next move is to wait, not to
    // delete their goal.
    expect(retryVerdict("building", false, MAX_BUILDS_PER_GOAL + 10)).toBe("still-building");
    expect(retryVerdict("awaiting_approval", false, MAX_BUILDS_PER_GOAL)).toBe("needs-approval");
  });

  it("still reports a healthy track as nothing-wrong, ceiling or not", () => {
    // The more specific truth. Telling someone with a working board that they
    // have rebuilt too often would send them to delete a goal that is fine.
    expect(retryVerdict("ready", true, MAX_BUILDS_PER_GOAL + 10)).toBe("nothing-wrong");
  });

  it("applies the ceiling to a ready goal with no board behind it", () => {
    // 'ready' with an empty board is broken, so it reaches the rebuild path -
    // and therefore has to reach the ceiling too, or it becomes the way to
    // loop forever.
    expect(retryVerdict("ready", false, MAX_BUILDS_PER_GOAL)).toBe("rebuild-limit");
    expect(retryVerdict("ready", false, 0)).toBe("allow");
  });
});

describe("cardBuildState - what a library card shows while it watches", () => {
  it("shows a course just started from the catalog as building, so the card watches it", () => {
    expect(cardBuildState("pending", false, false)).toBe("building");
  });

  it("shows a rebuild in flight as building whatever the list last stored", () => {
    // The list still holds the old outcome until the watcher reports back.
    expect(cardBuildState("failed", true, false)).toBe("building");
    expect(cardBuildState("pending", true, true)).toBe("building");
  });

  it("lets a stored outcome win over a stall timer that fired earlier", () => {
    // The timer is set while the status was pending; once the list learns
    // the outcome, holding on to "stalled" would offer a rebuild the server
    // refuses.
    expect(cardBuildState("ready", false, true)).toBe("ready");
    expect(cardBuildState("failed", false, true)).toBe("failed");
  });

  it("calls a pending build stalled once its timer fires", () => {
    expect(cardBuildState("pending", false, true)).toBe("stalled");
  });

  it("passes every settled status straight through", () => {
    expect(cardBuildState("ready", false, false)).toBe("ready");
    expect(cardBuildState("failed", false, false)).toBe("failed");
    expect(cardBuildState("awaiting_approval", false, false)).toBe("awaiting_approval");
  });
});

describe("canRebuild - only a course can be rebuilt since narrow Learn PR D", () => {
  it("offers a rebuild on a broken course, exactly where canRetry would", () => {
    expect(canRebuild("failed", true)).toBe(true);
    expect(canRebuild("stalled", true)).toBe(true);
  });

  it("never offers a rebuild on an earlier topic, because the route refuses one", () => {
    expect(canRebuild("failed", false)).toBe(false);
    expect(canRebuild("stalled", false)).toBe(false);
  });

  it("still refuses a course that is building, fine or waiting, whatever its kind", () => {
    for (const state of ["building", "ready", "awaiting_approval"] as const) {
      expect(canRebuild(state, true)).toBe(false);
    }
  });
});
