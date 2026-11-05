import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ImageCall } from "./imageInput";
import type { TextCall } from "./textInput";

const mocks = vi.hoisted(() => ({ sdk: vi.fn(), sdkCreate: vi.fn(), run: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mocks.sdkCreate };
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
const imageCall: ImageCall = { ...call, imageCaption: "The question.", images: [{ mediaType: "image/png", base64: "AAAA" }] };

beforeEach(() => vi.clearAllMocks());

describe("claudeClient", () => {
  it("builds the SDK client with the API key when the flag is off, exactly as every route did before", () => {
    claudeClient({ ANTHROPIC_API_KEY: "sk-ant-key", NODE_ENV: "production" });
    expect(mocks.sdk).toHaveBeenCalledWith({ apiKey: "sk-ant-key" });
  });

  it("hands a text call to the SDK unchanged, so the other call sites send what they always did", async () => {
    await claudeClient({ ANTHROPIC_API_KEY: "sk-ant-key" }).messages.create(call, { maxRetries: 0 });
    expect(mocks.sdkCreate).toHaveBeenCalledWith(call, { maxRetries: 0 });
  });

  it("sends images to the SDK as real image blocks, without the fields the API would reject", async () => {
    await claudeClient({ ANTHROPIC_API_KEY: "sk-ant-key" }).messages.createWithImages(imageCall, { maxRetries: 0 });
    const [params, options] = mocks.sdkCreate.mock.calls[0];
    expect(params).not.toHaveProperty("images");
    expect(params.messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    expect(options).toEqual({ maxRetries: 0 });
  });

  it("sends an image call to Hugh's own login on the plan, never the API key", async () => {
    await claudeClient(local).messages.createWithImages(imageCall, { maxRetries: 0 });
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledWith(imageCall, 0, expect.objectContaining({
      configDir: join(homedir(), SUBSCRIPTION_CONFIG_DIRNAME),
    }));
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

  it("gives every client the same limit latch, so a limit one route hit holds for all routes", async () => {
    await claudeClient(local).messages.create(call);
    await claudeClient(local).messages.create(call);
    const [first, second] = mocks.run.mock.calls.map(c => (c[2] as { limitLatch: unknown }).limitLatch);
    expect(first).toBeDefined();
    expect(second).toBe(first);
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
