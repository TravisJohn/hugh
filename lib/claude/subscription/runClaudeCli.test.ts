import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runClaudeCli, type RunnerConfig } from "./runClaudeCli";
import { SubscriptionCallError } from "./errors";
import { PlanLimitLatch } from "./limitLatch";
import type { TextCall } from "../textInput";

/**
 * Runs the real runner against a real child process — a node stand-in that
 * replays recorded `claude -p` output (fixtures/fake-claude.mjs). What it
 * proves can only be proved with a process: Hugh's secrets do not reach it,
 * the prompt arrives intact, and the tripwires kill it rather than waiting.
 */
const config: RunnerConfig = {
  command: process.execPath,
  commandArgs: [fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url))],
  configDir: "C:\\hugh-test-config",
  timeoutMs: 5_000,
  maxConcurrent: 2,
  limitLatch: new PlanLimitLatch(),
};

const call = (mode: string, content = "Ping."): TextCall => ({
  model: "claude-haiku-4-5",
  max_tokens: 20,
  system: mode,
  messages: [{ role: "user", content }],
});

const replyText = (message: Awaited<ReturnType<typeof runClaudeCli>>) =>
  message.content[0]?.type === "text" ? message.content[0].text : "";

async function failure(promise: Promise<unknown>): Promise<SubscriptionCallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SubscriptionCallError) return error;
    throw error;
  }
  throw new Error("expected a SubscriptionCallError");
}

describe("runClaudeCli", () => {
  const planted = ["ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
  beforeAll(() => { for (const name of planted) process.env[name] = "planted-secret"; });
  afterAll(() => { for (const name of planted) delete process.env[name]; });

  it("starts the child without any of Hugh's keys, pointed at Hugh's own login", async () => {
    const { names } = JSON.parse(replyText(await runClaudeCli(call("env"), 0, config))) as { names: string[] };
    for (const name of planted) expect(names).not.toContain(name);
    expect(names).toContain("CLAUDE_CONFIG_DIR");
  });

  it("removes the temporary folder holding the system prompt once the call ends", async () => {
    const { cwd } = JSON.parse(replyText(await runClaudeCli(call("env"), 0, config))) as { cwd: string };
    expect(existsSync(cwd)).toBe(false);
  });

  it("delivers the prompt through stdin intact, including non-ASCII text", async () => {
    const prompt = "Explain the p-value — “null” hypothesis, 95 % level, ñ";
    expect(replyText(await runClaudeCli(call("echo", prompt), 0, config))).toContain(`<user>\n${prompt}\n</user>`);
  });

  it("returns a recorded plan-served answer as an SDK Message", async () => {
    const message = await runClaudeCli(call("fixture:success-sonnet"), 0, config);
    expect(replyText(message)).toBe('{"ok": true}');
    expect(message.stop_reason).toBe("end_turn");
  });

  it("kills a child that starts on an API key immediately, before it can send a request", async () => {
    const started = Date.now();
    const error = await failure(runClaudeCli(call("fixture:error-api-key"), 0, config));
    expect(error.reason).toBe("billed_to_key");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("stops the CLI's automatic continuations at the first one and returns the API-shaped truncated reply", async () => {
    const started = Date.now();
    const message = await runClaudeCli(call("fixture:max-tokens"), 0, config);
    expect(message.stop_reason).toBe("max_tokens");
    expect(replyText(message)).toBe("Here are the numbers from 1 to 200, one per line:\n\n1\n2");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("reports a signed-out login as its own failure", async () => {
    expect((await failure(runClaudeCli(call("fixture:error-signed-out"), 0, config))).reason).toBe("signed_out");
  });

  it("stops a hung process at its time budget and says so", async () => {
    const error = await failure(runClaudeCli(call("hang"), 0, { ...config, timeoutMs: 300 }));
    expect(error.reason).toBe("timeout");
  });

  it("reports a missing binary as a failure rather than hanging", async () => {
    const error = await failure(runClaudeCli(call("echo"), 0, { ...config, command: "hugh-no-such-binary", commandArgs: [] }));
    expect(error.reason).toBe("failed");
  });

  it("after the plan reports its limit, refuses later calls without starting Claude Code", async () => {
    const limited = { ...config, limitLatch: new PlanLimitLatch() };
    const first = await failure(runClaudeCli(call("overage"), 0, limited));
    expect(first.reason).toBe("limit_reached");

    // A program that cannot start: had the runner tried, the reason would be "failed".
    const second = await failure(runClaudeCli(call("echo"), 0, { ...limited, command: "hugh-no-such-binary", commandArgs: [] }));
    expect(second.reason).toBe("limit_reached");
    expect(second.resetsAt).toEqual(first.resetsAt);
  });
});
