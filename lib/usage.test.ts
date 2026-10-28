import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ insert: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/afterResponse", () => ({
  deferOrRun: async (_schedule: unknown, task: () => Promise<void>) => task(),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({
      insert: async (row: unknown) => { mocks.insert(row); return { error: null }; },
      select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }),
    }),
    rpc: async () => ({ error: null }),
  }),
}));

import { logUsage } from "./usage";

/**
 * `logUsage` is the one place a row's model is written, so it is where a call
 * the owner's Claude plan served must become a $0 row — and where nothing
 * about that mode may touch a row some other provider was paid for.
 */
const OWNER = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const row = () => mocks.insert.mock.calls[0]?.[0] as { model: string | null; tokens_in: number; tokens_out: number };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("logUsage — who paid", () => {
  it("logs a plan-served Claude call under its $0 rate class, keeping the real token counts", async () => {
    vi.stubEnv("HUGH_CLAUDE_SUBSCRIPTION", "1");
    vi.stubEnv("HUGH_SUBSCRIPTION_OWNER_ID", OWNER);
    await logUsage({ userId: OWNER, feature: "learn/chat", model: "claude-haiku-4-5", tokensIn: 432, tokensOut: 13 });
    expect(row()).toMatchObject({ model: "claude-haiku-4-5@subscription", tokens_in: 432, tokens_out: 13 });
  });

  it("logs the route's own model on the API, so production rows are unchanged", async () => {
    await logUsage({ userId: OWNER, feature: "learn/chat", model: "claude-haiku-4-5", tokensIn: 432, tokensOut: 13 });
    expect(row().model).toBe("claude-haiku-4-5");
  });

  it("still records an OpenAI row, under its own id, even when the plan flag is misconfigured", async () => {
    vi.stubEnv("HUGH_CLAUDE_SUBSCRIPTION", "true");
    await logUsage({ userId: OWNER, feature: "notes/coach", model: "gpt-4o", tokensIn: 900, tokensOut: 200 });
    expect(row().model).toBe("gpt-4o");
  });
});
