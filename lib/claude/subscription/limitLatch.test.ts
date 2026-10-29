import { describe, it, expect } from "vitest";
import { PlanLimitLatch } from "./limitLatch";
import { SubscriptionCallError } from "./errors";

const NOW = new Date("2026-10-29T10:00:00Z");
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000);
const limit = (resetsAt: Date | null) => new SubscriptionCallError("limit_reached", "limit", resetsAt);

/**
 * Once the plan says it is out, asking again before the reset only starts
 * processes — and, were paid extra usage ever on, would bill each one.
 */
describe("PlanLimitLatch", () => {
  it("refuses until the reported reset time, carrying that time for the learner", () => {
    const latch = new PlanLimitLatch();
    latch.record(limit(inMinutes(90)), NOW);
    const refusal = latch.refusal(inMinutes(30));
    expect(refusal?.reason).toBe("limit_reached");
    expect(refusal?.resetsAt).toEqual(inMinutes(90));
  });

  it("lets calls through again once the limit has reset", () => {
    const latch = new PlanLimitLatch();
    latch.record(limit(inMinutes(90)), NOW);
    expect(latch.refusal(inMinutes(90))).toBeNull();
  });

  it("does not remember a limit with no reset time, since it could never honestly let go", () => {
    const latch = new PlanLimitLatch();
    latch.record(limit(null), NOW);
    expect(latch.refusal(NOW)).toBeNull();
  });

  it("ignores a reset time already in the past", () => {
    const latch = new PlanLimitLatch();
    latch.record(limit(inMinutes(-5)), NOW);
    expect(latch.refusal(NOW)).toBeNull();
  });

  it("ignores every other failure, so a timeout or a sign-in problem never reads as a limit", () => {
    const latch = new PlanLimitLatch();
    latch.record(new SubscriptionCallError("timeout", "slow"), NOW);
    latch.record(new SubscriptionCallError("signed_out", "login"), NOW);
    latch.record(new Error("anything"), NOW);
    expect(latch.refusal(NOW)).toBeNull();
  });

  it("keeps the later of two reset times, so a weekly limit is not cut short by a 5-hour one", () => {
    const latch = new PlanLimitLatch();
    latch.record(limit(inMinutes(60 * 24 * 3)), NOW);
    latch.record(limit(inMinutes(90)), NOW);
    expect(latch.refusal(inMinutes(120))?.resetsAt).toEqual(inMinutes(60 * 24 * 3));
  });
});
