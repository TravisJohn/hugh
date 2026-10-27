import { describe, it, expect, afterEach } from "vitest";
import { canUsePackLearn } from "./access";

describe("canUsePackLearn: the catalog is open to every learner (phase 2)", () => {
  afterEach(() => { delete process.env.PACK_LEARN_ENABLED; });

  it("lets any unblocked learner in, admin or not", () => {
    expect(canUsePackLearn({ is_blocked: false })).toBe(true);
  });

  it("keeps a blocked account out, and one whose blocked flag is unknown, so a missing value fails closed", () => {
    expect(canUsePackLearn({ is_blocked: true })).toBe(false);
    expect(canUsePackLearn({ is_blocked: null })).toBe(false);
    expect(canUsePackLearn({})).toBe(false);
  });

  it("is off with no profile at all", () => {
    expect(canUsePackLearn(null)).toBe(false);
    expect(canUsePackLearn(undefined)).toBe(false);
  });

  it("ignores the retired PACK_LEARN_ENABLED flag, so a stale Vercel value can't switch courses off", () => {
    process.env.PACK_LEARN_ENABLED = "false";
    expect(canUsePackLearn({ is_blocked: false })).toBe(true);
  });
});
