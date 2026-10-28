/**
 * Read a `claude -p --output-format stream-json` run back as the SDK `Message`
 * a route already knows how to handle — or as a `SubscriptionCallError`.
 *
 * Three behaviours of the CLI shape this file, each seen in a recorded run
 * (fixtures/ beside this file):
 *
 *   • A failure still says `subtype: "success"`. Only `is_error` is reliable,
 *     and the category sits on the assistant event's `error` field.
 *   • `init.apiKeySource` names the credential before any request is sent.
 *     Anything but "none" means an API key, not the plan, would pay.
 *   • On hitting `max_tokens` the CLI does not stop: it sends synthetic
 *     "Output token limit hit. Resume directly" turns and finally errors. The
 *     API would have returned the first, truncated reply with
 *     `stop_reason: "max_tokens"`, so that is what is rebuilt here.
 *
 * Pure: events in, message or error out. The runner owns the process.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { SubscriptionCallError } from "./errors";

export type CliEvent = Readonly<Record<string, unknown>>;

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** One stdout line as an event, or null for anything that is not a JSON object. */
export function parseEventLine(line: string): CliEvent | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The credential source an `init` event reports, or null for any other event. */
export function initApiKeySource(event: CliEvent): string | null {
  return event.type === "system" && event.subtype === "init" ? text(event.apiKeySource) : null;
}

/** The plan served the call only when no API key was in play. */
export const PLAN_KEY_SOURCE = "none";

/**
 * True for the CLI's own "keep going" turn after hitting `max_tokens`. With
 * no tools and one turn, nothing else can produce a `user` event mid-run.
 */
export function isContinuation(event: CliEvent): boolean {
  return event.type === "user" && event.isSynthetic === true;
}

export interface PlanLimit {
  status: string;
  resetsAt: Date | null;
  usingOverage: boolean;
}

/** The plan-limit report in a `rate_limit_event`, or null for any other event. */
export function planLimitOf(event: CliEvent): PlanLimit | null {
  if (event.type !== "rate_limit_event" || !isRecord(event.rate_limit_info)) return null;
  const info = event.rate_limit_info;
  const resets = count(info.resetsAt);
  return {
    status: text(info.status),
    resetsAt: resets > 0 ? new Date(resets * 1000) : null,
    usingOverage: info.isUsingOverage === true,
  };
}

const STOP_REASONS: readonly Anthropic.StopReason[] =
  ["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"];

function stopReason(v: unknown): Anthropic.StopReason | null {
  return STOP_REASONS.find(r => r === v) ?? null;
}

function usageFrom(v: unknown, outputOverride?: number): Anthropic.Usage {
  const u = isRecord(v) ? v : {};
  return {
    input_tokens:                count(u.input_tokens),
    output_tokens:               outputOverride ?? count(u.output_tokens),
    cache_creation_input_tokens: count(u.cache_creation_input_tokens),
    cache_read_input_tokens:     count(u.cache_read_input_tokens),
    cache_creation:              null,
    inference_geo:               null,
    output_tokens_details:       null,
    server_tool_use:             null,
    service_tier:                null,
  };
}

function assistantText(event: CliEvent): string {
  const message = isRecord(event.message) ? event.message : {};
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks.map(b => (isRecord(b) && b.type === "text" ? text(b.text) : "")).join("");
}

function buildMessage(
  first: CliEvent | undefined,
  init: CliEvent,
  body: string,
  stop: Anthropic.StopReason | null,
  usage: Anthropic.Usage,
): Anthropic.Message {
  const message = first && isRecord(first.message) ? first.message : {};
  return {
    id:            text(message.id) || "msg_subscription",
    type:          "message",
    role:          "assistant",
    model:         text(message.model) || text(init.model),
    content:       [{ type: "text", text: body, citations: null }],
    stop_reason:   stop,
    stop_sequence: null,
    stop_details:  null,
    container:     null,
    usage,
  };
}

export interface ParseOptions {
  /** The call's `max_tokens`: the output count of a reply cut off at the cap. */
  maxTokens: number;
  /** The runner stopped the process at the CLI's first continuation turn. */
  stoppedAtContinuation: boolean;
}

/**
 * The route's reply, rebuilt from the run. Throws `SubscriptionCallError` for
 * every way the run can fail to be a plan-served answer.
 */
export function toMessage(events: readonly CliEvent[], opts: ParseOptions): Anthropic.Message {
  const init = events.find(e => initApiKeySource(e) !== null);
  if (!init) throw new SubscriptionCallError("failed", "Claude Code ended before it started a session.");

  const source = initApiKeySource(init);
  if (source !== PLAN_KEY_SOURCE) {
    throw new SubscriptionCallError("billed_to_key",
      `Claude Code used "${source}" instead of the Claude plan. Nothing in Hugh's environment should provide a key.`);
  }

  const limits = events.map(planLimitOf).filter((l): l is PlanLimit => l !== null);
  const limit = limits[limits.length - 1] ?? null;
  if (limit?.usingOverage) {
    throw new SubscriptionCallError("limit_reached",
      "The Claude plan is drawing on paid extra usage, which subscription mode never uses.", limit.resetsAt);
  }

  const assistants = events.filter(e => e.type === "assistant");
  const first = assistants[0];
  const truncated = () => {
    if (!first) throw new SubscriptionCallError("failed", "Claude hit the output limit before writing anything.");
    const start = isRecord(first.message) ? first.message.usage : undefined;
    return buildMessage(first, init, assistantText(first), "max_tokens", usageFrom(start, opts.maxTokens));
  };
  if (opts.stoppedAtContinuation) return truncated();

  const result = events.find(e => e.type === "result");
  if (!result) throw new SubscriptionCallError("failed", "Claude Code ended without a result.");

  if (result.is_error === true) {
    const category = text([...assistants].reverse().find(e => typeof e.error === "string")?.error);
    const detail = text(result.result) || category || "unknown error";
    if (category === "max_output_tokens") return truncated();
    if (category === "rate_limit" || result.api_error_status === 429) {
      throw new SubscriptionCallError("limit_reached", detail, limit?.resetsAt ?? null);
    }
    if (category === "authentication_failed" || category === "oauth_org_not_allowed") {
      throw new SubscriptionCallError("signed_out", detail);
    }
    if (category === "model_not_found") throw new SubscriptionCallError("model_unavailable", detail);
    throw new SubscriptionCallError("failed", detail);
  }

  return buildMessage(first, init, text(result.result), stopReason(result.stop_reason), usageFrom(result.usage));
}
