import { describe, it, expect } from "vitest";
import {
  DEFAULT_MONTHLY_TOKEN_LIMIT,
  DEFAULT_RESERVE_ESTIMATE,
  RESERVE_ESTIMATES,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_SECONDS,
  RESERVE_TTL_SECONDS,
  tokenLimitFor,
  startOfMonth,
  periodStart,
  reserveEstimateFor,
  recordedTokens,
  accountAllowed,
  statusForDenial,
  messageForDenial,
} from "./tokenBudget";

/**
 * These tests exist because the quota rules are the only thing standing between
 * an open signup page and an unmetered Anthropic bill. Each one names the
 * money consequence of getting it wrong.
 */

describe("tokenLimitFor", () => {
  it("gives a free user the default cap when the profile sets none", () => {
    expect(tokenLimitFor({ plan: "free", approved: true })).toBe(DEFAULT_MONTHLY_TOKEN_LIMIT);
  });

  it("prefers a per-user token_limit over the default, so admin overrides stick", () => {
    expect(tokenLimitFor({ plan: "free", token_limit: 250_000 })).toBe(250_000);
  });

  it("honours a token_limit of 0 rather than falling back to the default", () => {
    // ?? not ||: a deliberate zero is how an account is throttled to nothing,
    // and || would silently hand it the full free allowance instead.
    expect(tokenLimitFor({ plan: "free", token_limit: 0 })).toBe(0);
  });

  it("returns null for pro and admin, preserving the display-only posture", () => {
    // Enforcing these would start refusing paying users — a product decision,
    // not a bug fix. Null means "not enforced", not "zero".
    expect(tokenLimitFor({ plan: "pro" })).toBeNull();
    expect(tokenLimitFor({ is_admin: true })).toBeNull();
  });

  it("treats a missing profile as a free user rather than as unlimited", () => {
    // A dropped profile read must not become a bypass.
    expect(tokenLimitFor(null)).toBe(DEFAULT_MONTHLY_TOKEN_LIMIT);
    expect(tokenLimitFor(undefined)).toBe(DEFAULT_MONTHLY_TOKEN_LIMIT);
  });
});

describe("periodStart", () => {
  const now = new Date("2026-09-04T17:30:00.000Z");

  it("counts from the first of the month when there is no reset", () => {
    expect(periodStart({ plan: "free" }, now)).toBe(startOfMonth(now));
  });

  it("counts from an admin reset that lands mid-month", () => {
    // The whole point of a reset is to forgive spend already logged.
    const reset = "2026-09-02T00:00:00.000Z";
    expect(periodStart({ usage_reset_at: reset }, now)).toBe(reset);
  });

  it("ignores a reset from a previous month", () => {
    // Otherwise one old reset would widen the window forever and the cap
    // would count tokens from months the learner has already been forgiven.
    const stale = "2026-07-11T00:00:00.000Z";
    expect(periodStart({ usage_reset_at: stale }, now)).toBe(startOfMonth(now));
  });

  it("treats a null reset the same as no reset", () => {
    expect(periodStart({ usage_reset_at: null }, now)).toBe(startOfMonth(now));
  });
});

describe("reserveEstimateFor", () => {
  it("reserves the registered amount for a known feature", () => {
    expect(reserveEstimateFor("learn/chat")).toBe(RESERVE_ESTIMATES["learn/chat"]);
  });

  it("reserves more for track generation than for the topic gate", () => {
    // The estimates are only useful if they rank the real spenders correctly;
    // a flat number would let a burst of generations past a cap.
    //
    // Both names are asserted to be REGISTERED first. An earlier version of
    // this test compared against "topic/gate", which is not a feature any route
    // uses — so it silently compared against the fallback and proved nothing.
    expect(RESERVE_ESTIMATES).toHaveProperty("tracker/generate");
    expect(RESERVE_ESTIMATES).toHaveProperty("learn/topic-domain");
    expect(reserveEstimateFor("tracker/generate"))
      .toBeGreaterThan(reserveEstimateFor("learn/topic-domain"));
  });

  it("reserves at least what the topic gate really costs", () => {
    // Measured at 743 + 41 = 784 against the live route on 2026-09-04. A
    // reservation under the real cost lets a burst overshoot the cap by the
    // difference, which is the one direction these estimates must not err in.
    expect(reserveEstimateFor("learn/topic-domain")).toBeGreaterThanOrEqual(784);
  });

  it("falls back to a non-zero estimate for an unregistered feature", () => {
    // A zero fallback is how adding a route and forgetting this table would
    // create a spender that consumes no budget at all.
    expect(reserveEstimateFor("some/new/route")).toBe(DEFAULT_RESERVE_ESTIMATE);
    expect(DEFAULT_RESERVE_ESTIMATE).toBeGreaterThan(0);
  });

  it("registers every estimate as a non-negative number", () => {
    for (const [feature, estimate] of Object.entries(RESERVE_ESTIMATES)) {
      expect(estimate, `${feature} must not reserve a negative`).toBeGreaterThanOrEqual(0);
    }
  });

});

describe("recordedTokens", () => {
  it("adds input and output together", () => {
    expect(recordedTokens(1_200, 300)).toBe(1_500);
  });

  it("never returns a negative, so a bad reading cannot refund budget", () => {
    expect(recordedTokens(-500, 100)).toBe(100);
    expect(recordedTokens(-500, -100)).toBe(0);
  });

  it("does not subtract what was reserved", () => {
    // Deliberate. One gated request can log several times (the goals route
    // bills three features off one gate), so reconciling per log row would
    // under-count by the estimates of the calls that reserved nothing.
    // Reservations expire on their own window instead.
    expect(recordedTokens(1_000, 0)).toBe(1_000);
  });
});

describe("accountAllowed", () => {
  it("refuses a blocked account before any counter is consulted", () => {
    expect(accountAllowed({ is_blocked: true, approved: true })).toEqual({
      allowed: false, reason: "blocked",
    });
  });

  it("refuses an unapproved account", () => {
    expect(accountAllowed({ approved: false })).toEqual({ allowed: false, reason: "blocked" });
  });

  it("lets an unapproved admin through, so approval cannot lock out the owner", () => {
    expect(accountAllowed({ approved: false, is_admin: true })).toEqual({ allowed: true });
  });

  it("blocks a blocked admin, because is_blocked outranks is_admin", () => {
    expect(accountAllowed({ is_blocked: true, is_admin: true })).toEqual({
      allowed: false, reason: "blocked",
    });
  });

  it("treats a missing profile as not allowed rather than allowed", () => {
    // A dropped read must fail closed here: this is the approval check, and
    // failing open would let an unapproved signup spend on day one.
    expect(accountAllowed(null).allowed).toBe(false);
  });
});

describe("denial responses", () => {
  it("maps both over-limit refusals to 429 and account refusals to 403", () => {
    expect(statusForDenial("limit_reached")).toBe(429);
    expect(statusForDenial("rate_limited")).toBe(429);
    expect(statusForDenial("blocked")).toBe(403);
    expect(statusForDenial(undefined)).toBe(403);
  });

  it("gives each refusal its own sentence", () => {
    // Rule 5: a failure must be distinguishable. "Slow down" and "you are out
    // of budget for the month" need different ways out.
    const messages = [
      messageForDenial("limit_reached"),
      messageForDenial("rate_limited"),
      messageForDenial("blocked"),
    ];
    expect(new Set(messages).size).toBe(3);
  });

  it("tells a rate-limited learner to wait, not to contact support", () => {
    expect(messageForDenial("rate_limited")).toMatch(/wait/i);
  });
});

describe("window configuration", () => {
  it("permits normal use — a chat turn every few seconds stays under the cap", () => {
    expect(RATE_LIMIT_MAX_REQUESTS).toBeGreaterThanOrEqual(20);
    expect(RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it("holds a reservation longer than the slowest gated request can run", () => {
    // The track-build routes set maxDuration = 120. A TTL shorter than that
    // would expire a build's own reservation while it was still running, and
    // the cap would stop protecting anything during the most expensive call
    // in the product.
    expect(RESERVE_TTL_SECONDS).toBeGreaterThan(120);
  });
});
