import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ClaudeClient } from "./client";
import { imageReservation, type ImageCall } from "./imageInput";
import { textReservation, type TextCall } from "./textInput";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => mocks }));
import { chargedInputTokens, createImageMessage, createTextMessage, textBudgetResponse } from "./textBudget";
import { checkUsageAllowed, enforceUsageGate, enforceTtsBudget } from "@/lib/usage";

const call: TextCall = { model: "claude-haiku-4-5", max_tokens: 500, system: "Python helper", messages: [{ role: "user", content: "x".repeat(16000) }] };
const ai = vi.fn();
const aiWithImages = vi.fn();
const client = { messages: { create: ai, createWithImages: aiWithImages } } as unknown as ClaudeClient;
const imageCall: ImageCall = { ...call, imageCaption: "The question.", images: [{ mediaType: "image/png", base64: "AAAA" }] };
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

describe("a call with images goes through the same gate as text", () => {
  it("reserves the image hold under the route's own name and makes exactly one attempt", async () => {
    await createImageMessage(client, "alice", "notes/coach", imageCall);
    expect(mocks.rpc).toHaveBeenCalledWith("reserve_usage", expect.objectContaining({ p_estimate: imageReservation(imageCall), p_feature: "notes/coach" }));
    expect(aiWithImages).toHaveBeenCalledWith(imageCall, { maxRetries: 0 });
    expect(ai).not.toHaveBeenCalled();
  });
  it("spends nothing when the gate refuses, and says why", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ granted: false, reason: "rate_limited", retry_after: 23 }], error: null });
    try { await createImageMessage(client, "alice", "notes/coach", imageCall); throw new Error("Must refuse"); }
    catch (error) { expect(textBudgetResponse(error)?.status).toBe(429); }
    expect(aiWithImages).not.toHaveBeenCalled();
  });
});

describe("chargedInputTokens", () => {
  const usage = (input: number, write: number | null, read: number | null) =>
    ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read }) as Anthropic.Usage;
  it("counts cache writes, because the plan reports most of a call's input that way", () => {
    expect(chargedInputTokens(usage(3, 1976, 0))).toBe(1979);
  });
  it("leaves cache reads out, as learn/chat does", () => {
    expect(chargedInputTokens(usage(100, 0, 5000))).toBe(100);
  });
  it("copes with an API reply that has no cache fields", () => {
    expect(chargedInputTokens(usage(100, null, null))).toBe(100);
  });
});

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
  it("retains the legacy estimate for unrelated routes", async () => {
    await checkUsageAllowed("alice", "tts");
    expect(mocks.rpc.mock.calls[0][1].p_estimate).toBe(0);
  });
  it.each([{}, { plan: "pro" }, { is_admin: true }])("refuses unestimated billable calls when the RPC fails: %j", async extra => {
    profile = { approved: true, ...extra };
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    const response = await enforceUsageGate("alice", "tts");
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

describe("TTS character admission", () => {
  it.each([
    [{}, 20_000],
    [{ plan: "pro" }, 100_000],
    [{ is_admin: true }, 100_000],
  ])("uses a monthly character cap for every plan: %j", async (extra, limit) => {
    profile = { approved: true, ...extra };
    expect(await enforceTtsBudget("alice", 2000)).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith("reserve_tts", expect.objectContaining({
      p_user_id: "alice", p_chars: 2000, p_char_limit: limit,
    }));
  });

  it("returns 429 when the atomic character cap is exhausted", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ granted: false, chars_after: 20_000 }], error: null });
    expect((await enforceTtsBudget("alice", 1))?.status).toBe(429);
  });

  it("fails closed when character admission is unavailable", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    const response = await enforceTtsBudget("alice", 2000);
    expect(response?.status).toBe(503);
    expect(response?.headers.get("Retry-After")).toBe("30");
  });
});
