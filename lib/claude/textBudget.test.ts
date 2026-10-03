import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { textReservation, type TextCall } from "./textInput";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => mocks }));
import { createTextMessage, textBudgetResponse } from "./textBudget";
import { checkUsageAllowed, enforceUsageGate } from "@/lib/usage";

const call: TextCall = { model: "claude-haiku-4-5", max_tokens: 500, system: "Python helper", messages: [{ role: "user", content: "x".repeat(16000) }] };
const ai = vi.fn();
const client = { messages: { create: ai } } as unknown as Anthropic;
let profile: { approved: boolean; is_blocked?: boolean; is_admin?: boolean; plan?: string };
beforeEach(() => {
  vi.clearAllMocks();
  profile = { approved: true };
  mocks.from.mockImplementation((table: string) => {
    if (table !== "profiles") throw new Error("Dynamic reservations must not use usage_logs fallback");
    return { select: () => ({ eq: () => ({ single: async () => ({ data: profile, error: null }) }) }) };
  });
  mocks.rpc.mockReset().mockResolvedValue({ data: [{ granted: true }], error: null });
  ai.mockResolvedValue({ content: [{ type: "text", text: "A reply" }] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("prompt-size reservation reaches the atomic RPC", () => {
  it("passes the computed estimate, not the old 3000-token constant", async () => {
    await createTextMessage(client, "alice", "code/chat", call);
    expect(mocks.rpc).toHaveBeenCalledWith("reserve_usage", expect.objectContaining({ p_estimate: textReservation(call), p_user_id: "alice", p_token_limit: 100000 }));
    expect(ai).toHaveBeenCalledWith(call, { maxRetries: 0 });
  });
  it.each([{}, { plan: "pro" }, { is_admin: true }])("fails closed when prompt reservation is unavailable: %j", async extra => {
    profile = { approved: true, ...extra };
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    try { await createTextMessage(client, "alice", "code/chat", call); throw new Error("Must refuse"); }
    catch (error) { expect(textBudgetResponse(error)?.status).toBe(503); }
    expect(ai).not.toHaveBeenCalled();
  });
  it("blocked/unapproved users cannot reserve or call the provider", async () => {
    for (const state of [{ approved: false }, { approved: true, is_blocked: true }]) {
      profile = state;
      expect((await enforceUsageGate("alice", "code/chat", textReservation(call)))?.status).toBe(403);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("preserves rate-limit status and Retry-After", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ granted: false, reason: "rate_limited", retry_after: 23 }], error: null });
    const response = await enforceUsageGate("alice", "code/chat", textReservation(call));
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("23");
  });
  it("rejects invalid server reservation configuration", async () => {
    for (const value of [NaN, Infinity, -1, 1.5]) await expect(checkUsageAllowed("alice", "code/chat", value)).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([{}, { plan: "pro" }, { is_admin: true }])("refuses unestimated billable calls when the RPC fails: %j", async extra => {
    profile = { approved: true, ...extra };
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    const response = await enforceUsageGate("alice", "code/chat");
    expect(response?.status).toBe(503);
    expect(response?.headers.get("Retry-After")).toBe("30");
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });
  it.each([
    { name: "thrown RPC", run: () => mocks.rpc.mockRejectedValue(new Error("offline")) },
    { name: "empty decision", run: () => mocks.rpc.mockResolvedValue({ data: null, error: null }) },
    { name: "invalid decision", run: () => mocks.rpc.mockResolvedValue({ data: [{ granted: false, reason: "unknown" }], error: null }) },
  ])("refuses an unusable reservation result: $name", async ({ run }) => {
    run();
    const response = await enforceUsageGate("alice", "code/generate-drill");
    expect(response?.status).toBe(503);
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });
  it("only admitted calls reach the provider in a near-limit burst", async () => {
    // Contract double for SQL's atomic compare/add. The separate PostgreSQL
    // test exercises the real row lock with eight simultaneous connections.
    let reserved = 0;
    const remaining = textReservation(call) + 1;
    mocks.rpc.mockImplementation(async (_name: string, args: { p_estimate: number }) => {
      const granted = reserved + args.p_estimate <= remaining;
      if (granted) reserved += args.p_estimate;
      return { data: [{ granted, reason: granted ? null : "limit_reached" }], error: null };
    });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => createTextMessage(client, "alice", "code/chat", call)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(ai).toHaveBeenCalledOnce();
    expect(reserved).toBe(textReservation(call));
  });
});
