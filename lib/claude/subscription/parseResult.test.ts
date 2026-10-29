import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseEventLine,
  initApiKeySource,
  isContinuation,
  planLimitOf,
  toMessage,
  type CliEvent,
} from "./parseResult";
import { SubscriptionCallError, type SubscriptionFailure } from "./errors";

/**
 * Every fixture is a real `claude -p` run recorded on 2026-10-28 (Claude Code
 * 2.1.283) with machine-specific values replaced. The failure these tests
 * guard is a plan-mode call that looks like it worked when it did not — an
 * error read as an answer, or an API key quietly paying for it.
 */
function events(name: string): CliEvent[] {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .map(parseEventLine)
    .filter((e): e is CliEvent => e !== null);
}

function failure(run: () => unknown): SubscriptionCallError {
  try {
    run();
  } catch (error) {
    if (error instanceof SubscriptionCallError) return error;
    throw error;
  }
  throw new Error("expected a SubscriptionCallError");
}

const opts = { maxTokens: 1024, stoppedAtContinuation: false };

describe("toMessage — answers", () => {
  it("rebuilds a plan-served reply as the SDK Message a route already reads", () => {
    const message = toMessage(events("success-sonnet"), opts);
    expect(message.content).toEqual([{ type: "text", text: '{"ok": true}', citations: null }]);
    expect(message.stop_reason).toBe("end_turn");
    expect(message.model).toBe("claude-sonnet-4-6");
    expect(message.usage).toMatchObject({ input_tokens: 372, output_tokens: 8 });
  });

  it("passes the reply text through untouched, fences and all, so route parsers see what the model wrote", () => {
    const message = toMessage(events("success-haiku"), opts);
    expect(message.content[0]).toMatchObject({ text: '```json\n{"ok": true}\n```' });
  });
});

describe("toMessage — who paid", () => {
  it("refuses a run that an API key paid for, even though that run also failed", () => {
    expect(failure(() => toMessage(events("error-api-key"), opts)).reason).toBe("billed_to_key");
  });

  it("refuses a successful reply if the start-up event named a key, so a paid answer is never returned as a free one", () => {
    const paid = events("success-haiku").map(e =>
      initApiKeySource(e) !== null ? { ...e, apiKeySource: "ANTHROPIC_API_KEY" } : e);
    expect(failure(() => toMessage(paid, opts)).reason).toBe("billed_to_key");
  });

  it("reads the plan's own credential as the plan", () => {
    expect(events("success-haiku").map(initApiKeySource).filter(s => s !== null)).toEqual(["none"]);
  });
});

describe("toMessage — failures read as failures", () => {
  const cases: [string, SubscriptionFailure][] = [
    ["error-signed-out", "signed_out"],
    ["error-unknown-model", "model_unavailable"],
  ];
  it.each(cases)("%s fails as %s even though the CLI labels it subtype \"success\"", (fixture, reason) => {
    const run = events(fixture);
    expect(run.find(e => e.type === "result")).toMatchObject({ subtype: "success", is_error: true });
    expect(failure(() => toMessage(run, opts)).reason).toBe(reason);
  });

  it("reports a plan-limit refusal with its reset time, so the learner is told when to come back", () => {
    const limited = events("success-haiku").map(e => {
      if (e.type === "assistant") return { ...e, error: "rate_limit" };
      if (e.type === "result") return { ...e, is_error: true, result: "You've hit your session limit · resets 3:45pm" };
      return e;
    });
    const error = failure(() => toMessage(limited, opts));
    expect(error.reason).toBe("limit_reached");
    expect(error.resetsAt).toEqual(new Date(1793196600 * 1000));
  });

  it("refuses a run that drew on paid extra usage, so the plan never becomes a bill", () => {
    const overage = events("success-haiku").map(e =>
      planLimitOf(e) ? { ...e, rate_limit_info: { ...(e.rate_limit_info as object), isUsingOverage: true } } : e);
    expect(failure(() => toMessage(overage, opts)).reason).toBe("limit_reached");
  });

  it("fails a run that died before starting or before finishing, rather than returning an empty answer", () => {
    expect(failure(() => toMessage([], opts)).reason).toBe("failed");
    const noResult = events("success-haiku").filter(e => e.type !== "result");
    expect(failure(() => toMessage(noResult, opts)).reason).toBe("failed");
  });
});

describe("toMessage — the output cap behaves like the API", () => {
  const firstChunk = "Here are the numbers from 1 to 200, one per line:\n\n1\n2";

  it("returns the first, truncated reply with stop_reason max_tokens when the CLI gives up after continuing", () => {
    const message = toMessage(events("max-tokens"), { maxTokens: 20, stoppedAtContinuation: false });
    expect(message.stop_reason).toBe("max_tokens");
    expect(message.content[0]).toMatchObject({ text: firstChunk });
    expect(message.usage).toMatchObject({ input_tokens: 368, output_tokens: 20 });
  });

  it("returns the same reply when the runner stops the CLI at its first continuation", () => {
    const run = events("max-tokens");
    const upTo = run.slice(0, run.findIndex(isContinuation));
    const message = toMessage(upTo, { maxTokens: 20, stoppedAtContinuation: true });
    expect(message.stop_reason).toBe("max_tokens");
    expect(message.content[0]).toMatchObject({ text: firstChunk });
  });
});

describe("event helpers", () => {
  it("recognises only the CLI's synthetic continuation turns", () => {
    expect(events("max-tokens").filter(isContinuation)).toHaveLength(3);
    expect(events("success-haiku").some(isContinuation)).toBe(false);
  });

  it("reads the plan-limit report", () => {
    const limit = events("success-haiku").map(planLimitOf).find(l => l !== null);
    expect(limit).toEqual({ status: "allowed", resetsAt: new Date(1793196600 * 1000), usingOverage: false });
  });

  it("ignores stdout lines that are not JSON objects instead of crashing the run", () => {
    expect(parseEventLine("Waiting for background work to finish")).toBeNull();
    expect(parseEventLine("[1,2]")).toBeNull();
    expect(parseEventLine("")).toBeNull();
  });
});
