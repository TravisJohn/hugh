import { describe, it, expect } from "vitest";
import {
  checkRequest, mayRequestAnother, requestWindowStart,
  DAILY_REQUEST_LIMIT, MAX_REQUEST_CHARS, REQUEST_REJECTION_MESSAGE,
} from "./topicRequest";

describe("checkRequest", () => {
  it("accepts a subject and stores it as one trimmed line, the shape migration 061 requires", () => {
    expect(checkRequest("  Causal\ninference\t ")).toEqual({ ok: true, text: "Causal inference" });
  });

  it("refuses an empty or blank request, so the admin list never fills with nothing", () => {
    expect(checkRequest("")).toEqual({ ok: false, rejection: "empty" });
    expect(checkRequest("   \n ")).toEqual({ ok: false, rejection: "empty" });
  });

  it("treats anything that isn't text as empty rather than throwing", () => {
    expect(checkRequest(undefined)).toEqual({ ok: false, rejection: "empty" });
    expect(checkRequest(42)).toEqual({ ok: false, rejection: "empty" });
  });

  it("accepts exactly the limit and refuses one character more, matching the table's CHECK", () => {
    expect(checkRequest("x".repeat(MAX_REQUEST_CHARS)).ok).toBe(true);
    expect(checkRequest("x".repeat(MAX_REQUEST_CHARS + 1))).toEqual({ ok: false, rejection: "too_long" });
  });

  it("measures the request after tidying, so padding can't push a short subject over the limit", () => {
    expect(checkRequest(`   ${"x".repeat(MAX_REQUEST_CHARS)}   `).ok).toBe(true);
  });
});

describe("the daily limit", () => {
  it("allows requests up to the limit and refuses the next one", () => {
    expect(mayRequestAnother(DAILY_REQUEST_LIMIT - 1)).toBe(true);
    expect(mayRequestAnother(DAILY_REQUEST_LIMIT)).toBe(false);
  });

  it("counts a rolling 24 hours, so the limit doesn't reset at an arbitrary midnight", () => {
    const now = new Date("2026-10-25T09:30:00Z");
    expect(requestWindowStart(now).toISOString()).toBe("2026-10-24T09:30:00.000Z");
  });
});

describe("rejection copy", () => {
  it("gives every rejection its own sentence (Rule 5)", () => {
    const messages = Object.values(REQUEST_REJECTION_MESSAGE);
    expect(new Set(messages).size).toBe(messages.length);
  });
});
