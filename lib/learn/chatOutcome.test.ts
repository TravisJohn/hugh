import { describe, it, expect } from "vitest";
import { chatOutcome, chatOutcomeOfThrown, retryHint } from "./chatOutcome";

// The real sentence enforceUsageGate sends, from lib/tokenBudget.
const LIMIT_MESSAGE = "Monthly usage limit reached. Please contact Travis to reset or upgrade.";

describe("chatOutcome - the server's own words, where it wrote them for a learner", () => {
  it("shows the budget refusal instead of a generic apology", () => {
    // The defect this item exists for: the learner used to be told "Sorry,
    // something went wrong. Please try again." and had no way to learn why.
    const out = chatOutcome(429, { error: LIMIT_MESSAGE });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toBe(LIMIT_MESSAGE);
  });

  it("shows a restricted-account refusal in the server's words", () => {
    const out = chatOutcome(403, { error: "Your access has been restricted. Please contact support." });
    if (!out.ok) expect(out.message).toBe("Your access has been restricted. Please contact support.");
  });

  it("keeps our wording for the refusals written for a log", () => {
    // "Unauthorized" is for whoever reads the server logs, not for a learner
    // halfway through a question.
    const out = chatOutcome(401, { error: "Unauthorized" });
    if (!out.ok) {
      expect(out.message).not.toContain("Unauthorized");
      expect(out.reason).toBe("signed-out");
    }
  });

  it("keeps our wording when a human-copy status arrives with no body", () => {
    const out = chatOutcome(429, {});
    if (!out.ok) expect(out.message).toBe("You've reached your usage limit, so Hugh couldn't answer that one.");
  });

  it("does not show an empty server message", () => {
    const out = chatOutcome(403, { error: "   " });
    if (!out.ok) expect(out.message.trim().length).toBeGreaterThan(0);
  });

  it("shows why an earlier topic is read-only, and offers no retry that could not work", () => {
    // narrow Learn PR D: the card is refused for good, so the learner needs the
    // reason, not "Hugh couldn't take that question" and a Send-again button.
    const READ_ONLY = "This is an earlier topic, kept for you to read. It wasn't built from a source-checked course.";
    const out = chatOutcome(409, { error: READ_ONLY });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toBe(READ_ONLY);
      expect(out.canRetry).toBe(false);
    }
  });
});

describe("chatOutcome - nothing to append to the conversation", () => {
  it("carries no reply on any failure, so a refusal cannot become a message", () => {
    // Structural, not careful: the old code appended its substitute as a turn
    // from Hugh, and it reached Claude's history, the summariser and the diary.
    const out = chatOutcome(500, { error: "boom" });
    expect(out.ok).toBe(false);
    expect("reply" in out).toBe(false);
  });

  it("treats a success carrying no reply as a failure, not a blank turn", () => {
    const out = chatOutcome(200, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("empty");
  });

  it("treats a whitespace-only reply the same way", () => {
    const out = chatOutcome(200, { reply: "   \n  " });
    expect(out.ok).toBe(false);
  });

  it("passes a real reply through, trimmed", () => {
    const out = chatOutcome(200, { reply: "  A pivot table groups rows.  " });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.reply).toBe("A pivot table groups rows.");
  });
});

describe("chatOutcome - whether sending again could help", () => {
  it("offers no retry for a lapsed session or a spent budget", () => {
    const signedOut = chatOutcome(401, {});
    const limited   = chatOutcome(429, { error: LIMIT_MESSAGE });
    if (!signedOut.ok) expect(signedOut.canRetry).toBe(false);
    if (!limited.ok)   expect(limited.canRetry).toBe(false);
  });

  it("offers a retry when Hugh's own side failed", () => {
    const out = chatOutcome(502, { error: "Failed to generate response" });
    if (!out.ok) {
      expect(out.reason).toBe("server");
      expect(out.canRetry).toBe(true);
    }
  });
});

describe("chatOutcome - retryAfter arrives as untrusted JSON", () => {
  it("keeps a sensible number", () => {
    const out = chatOutcome(429, { error: LIMIT_MESSAGE, retryAfter: 45 });
    if (!out.ok) expect(out.retryAfterSeconds).toBe(45);
  });

  it("ignores values that would render a countdown that never ends", () => {
    for (const bad of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY, "60", null, undefined]) {
      const out = chatOutcome(429, { retryAfter: bad });
      if (!out.ok) expect(out.retryAfterSeconds).toBeNull();
    }
  });

  it("rounds a fractional wait up rather than down", () => {
    // Rounding down would invite a retry that is refused again.
    const out = chatOutcome(429, { retryAfter: 12.2 });
    if (!out.ok) expect(out.retryAfterSeconds).toBe(13);
  });
});

describe("chatOutcomeOfThrown", () => {
  it("reads a dropped connection as unreachable, with a retry", () => {
    const out = chatOutcomeOfThrown(new TypeError("Failed to fetch"));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("unreachable");
      expect(out.canRetry).toBe(true);
    }
  });

  it("reads anything else as Hugh's fault, since the reply had already arrived", () => {
    const out = chatOutcomeOfThrown(new SyntaxError("Unexpected token <"));
    if (!out.ok) expect(out.reason).toBe("server");
  });
});

describe("retryHint", () => {
  it("says nothing when there is no wait to report", () => {
    expect(retryHint(null)).toBeNull();
    expect(retryHint(0)).toBeNull();
  });

  it("counts in seconds under a minute, singular at one", () => {
    expect(retryHint(1)).toBe("You can try again in 1 second.");
    expect(retryHint(45)).toBe("You can try again in 45 seconds.");
  });

  it("switches to minutes once a second count stops being useful", () => {
    expect(retryHint(60)).toBe("You can try again in about 1 minute.");
    expect(retryHint(150)).toBe("You can try again in about 3 minutes.");
  });
});
