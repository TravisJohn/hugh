import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  describePlanFailure,
  paidServiceOffMessage,
  paidServiceOffResponse,
  planFailureResponse,
} from "./planResponses";
import { SubscriptionCallError, type SubscriptionFailure } from "./errors";

const NOW = new Date("2026-10-29T04:00:00Z");
const RESETS = new Date("2026-10-29T04:45:00Z");
const context = { now: NOW, configDir: "C:\\Users\\owner\\.claude-hugh", timeZone: "Australia/Sydney" };
const fail = (reason: SubscriptionFailure, resetsAt: Date | null = null) =>
  new SubscriptionCallError(reason, "detail", resetsAt);

/**
 * Rule 5: on the plan, "you're out until Thursday", "Hugh's login expired"
 * and "Claude was slow" each need their own sentence and their own way out.
 */
describe("describePlanFailure", () => {
  it("gives every way a plan call can fail its own sentence", () => {
    const reasons: SubscriptionFailure[] =
      ["limit_reached", "signed_out", "billed_to_key", "model_unavailable", "timeout", "failed"];
    const messages = reasons.map(r => describePlanFailure(fail(r, RESETS), context).message);
    expect(new Set(messages).size).toBe(reasons.length);
  });

  it("tells the learner when the plan's limit resets, and that nothing was switched to paid", () => {
    const reply = describePlanFailure(fail("limit_reached", RESETS), context);
    expect(reply.status).toBe(429);
    expect(reply.message).toMatch(/resets Thursday 3:45\spm/);
    expect(reply.message).toMatch(/did not switch to paid/);
    expect(reply.retryAfter).toBe(45 * 60);
  });

  it("still says nothing was switched to paid when the plan gave no reset time", () => {
    const reply = describePlanFailure(fail("limit_reached"), context);
    expect(reply.status).toBe(429);
    expect(reply.message).toMatch(/did not switch to paid/);
    expect(reply.retryAfter).toBeUndefined();
  });

  it("names the login folder it looked in, since a wrong folder reads exactly like signed out", () => {
    const reply = describePlanFailure(fail("signed_out"), context);
    expect(reply.message).toContain(context.configDir);
    expect(reply.message).toContain("npm run subscription:login");
  });

  it("keeps waiting and breakage apart: a timeout is not a 'try later' limit", () => {
    expect(describePlanFailure(fail("timeout"), context).status).toBe(504);
    expect(describePlanFailure(fail("failed"), context).status).toBe(502);
  });
});

describe("paidServiceOffResponse", () => {
  const plan = { HUGH_CLAUDE_SUBSCRIPTION: "1", HUGH_SUBSCRIPTION_OWNER_ID: "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f" };

  it("lets the paid feature run on the API", () => {
    expect(paidServiceOffResponse("The Coach", {})).toBeNull();
  });

  it("switches it off on the plan, saying why and how to get it back", async () => {
    const response = paidServiceOffResponse("The Coach", plan);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: paidServiceOffMessage("The Coach") });
    expect(paidServiceOffMessage("The Coach")).toMatch(/^The Coach is off .* npm run dev .*\(paid\)/);
  });

  it("refuses rather than spends when the flag is set wrongly", () => {
    expect(() => paidServiceOffResponse("The Coach", { HUGH_CLAUDE_SUBSCRIPTION: "yes" })).toThrow();
  });
});

describe("planFailureResponse", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it("leaves every other error to the route's own handling", () => {
    expect(planFailureResponse(new Error("network"))).toBeNull();
  });

  it("answers a plan limit with 429, the sentence and a Retry-After the browser can use", async () => {
    const response = planFailureResponse(fail("limit_reached", RESETS), NOW);
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe(String(45 * 60));
    expect((await response?.json()).error).toMatch(/did not switch to paid/);
  });

  it("records Claude Code's own reason in the server log", () => {
    planFailureResponse(fail("failed"), NOW);
    expect(console.warn).toHaveBeenCalledWith("[subscription] failed: detail");
  });
});
