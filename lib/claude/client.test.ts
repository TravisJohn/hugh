import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TextCall } from "./textInput";

const mocks = vi.hoisted(() => ({ sdk: vi.fn(), run: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: vi.fn() };
    constructor(options: unknown) { mocks.sdk(options); }
  },
}));
vi.mock("./subscription/runClaudeCli", () => ({ runClaudeCli: mocks.run }));

import { claudeClient, SUBSCRIPTION_CONFIG_DIRNAME } from "./client";
import { SubscriptionModeError } from "./billingMode";

/**
 * One factory decides who pays for all 19 Claude call sites, so these tests
 * pin the two things a route can't see for itself: production is unchanged,
 * and the plan path never touches the API key.
 */
const OWNER = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const local = { HUGH_CLAUDE_SUBSCRIPTION: "1", HUGH_SUBSCRIPTION_OWNER_ID: OWNER, NODE_ENV: "development", ANTHROPIC_API_KEY: "sk-ant-key" };
const call: TextCall = { model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] };

beforeEach(() => vi.clearAllMocks());

describe("claudeClient", () => {
  it("builds the SDK client with the API key when the flag is off, exactly as every route did before", () => {
    claudeClient({ ANTHROPIC_API_KEY: "sk-ant-key", NODE_ENV: "production" });
    expect(mocks.sdk).toHaveBeenCalledWith({ apiKey: "sk-ant-key" });
  });

  it("never builds the SDK client on the plan, so the API key is not even read", () => {
    claudeClient(local);
    expect(mocks.sdk).not.toHaveBeenCalled();
  });

  it("sends a plan call to Hugh's own Claude Code login, passing the caller's retry count", async () => {
    await claudeClient(local).messages.create(call, { maxRetries: 0 });
    expect(mocks.run).toHaveBeenCalledWith(call, 0, expect.objectContaining({
      command: "claude",
      configDir: join(homedir(), SUBSCRIPTION_CONFIG_DIRNAME),
      maxConcurrent: 2,
    }));
  });

  it("leaves the retry count to the runner's SDK-matching default when the caller sets none", async () => {
    await claudeClient(local).messages.create(call);
    expect(mocks.run).toHaveBeenCalledWith(call, undefined, expect.anything());
  });

  it("refuses to build any client with the flag set in a production build, so the build fails loudly", () => {
    expect(() => claudeClient({ ...local, NODE_ENV: "production" })).toThrow(SubscriptionModeError);
    expect(mocks.sdk).not.toHaveBeenCalled();
  });
});
