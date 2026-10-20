import { describe, it, expect } from "vitest";
import { canUsePackLearn } from "./access";

describe("canUsePackLearn: courses are an administrator preview in phase 1", () => {
  it("lets an unblocked admin in when the flag is on", () => {
    expect(canUsePackLearn("true", { is_admin: true, is_blocked: false })).toBe(true);
  });

  it("keeps every learner out, even with the flag on, so learners see nothing new", () => {
    expect(canUsePackLearn("true", { is_admin: false, is_blocked: false })).toBe(false);
    expect(canUsePackLearn("true", { is_admin: null, is_blocked: false })).toBe(false);
  });

  it("keeps a blocked admin out, and an admin whose blocked flag is unknown", () => {
    expect(canUsePackLearn("true", { is_admin: true, is_blocked: true })).toBe(false);
    expect(canUsePackLearn("true", { is_admin: true, is_blocked: null })).toBe(false);
  });

  it("is off unless the flag is exactly 'true', so a typo fails closed", () => {
    for (const flag of [undefined, "", "1", "TRUE", "yes"]) {
      expect(canUsePackLearn(flag, { is_admin: true, is_blocked: false })).toBe(false);
    }
  });

  it("is off with no profile at all", () => {
    expect(canUsePackLearn("true", null)).toBe(false);
    expect(canUsePackLearn("true", undefined)).toBe(false);
  });
});
