/**
 * The Claude client every route and Claude-calling `lib` module uses.
 *
 * On the API — the default, and the only mode a production build allows — this
 * is the Anthropic SDK client, exactly as before. In local subscription mode it
 * is a client with the same `messages.create` shape that runs the call through
 * the installed `claude` binary on the owner's own plan
 * (docs/claude-subscription-local-mode.md). Routes keep their `MODEL`, their
 * prompts and their parsers either way; only who pays changes.
 *
 * The type is deliberately narrower than the SDK's: `create` takes a
 * `TextCall`, the one shape the plan path supports. A call site that wants
 * tools, images or a stream fails to compile here instead of misbehaving on the
 * plan.
 *
 * No `server-only` import: `lib/tracker/generateMilestones.ts` reaches this
 * from offline `tsx` scripts, which run outside Next.
 */
import Anthropic from "@anthropic-ai/sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveClaudeBilling } from "./billingMode";
import type { TextCall } from "./textInput";
import { runClaudeCli } from "./subscription/runClaudeCli";
import { PlanLimitLatch } from "./subscription/limitLatch";

export interface ClaudeClient {
  messages: {
    create(call: TextCall, options?: { maxRetries?: number }): Promise<Anthropic.Message>;
  };
}

/**
 * Hugh's own Claude Code login, kept apart from the owner's everyday one so
 * their CLAUDE.md, memory and plugins never reach Hugh's prompts. Built from
 * the home folder, never typed: a wrong path reads exactly like "signed out".
 */
export const SUBSCRIPTION_CONFIG_DIRNAME = ".claude-hugh";

/** Where that login lives. The sign-in message names it, so it must be this one path. */
export function subscriptionConfigDir(): string {
  return join(homedir(), SUBSCRIPTION_CONFIG_DIRNAME);
}

/**
 * A hang guard, not a budget: the longest call (the review quiz, 3,072 output
 * tokens on Sonnet) takes about a minute, and the track-build routes allow
 * 120 s in total.
 */
const PLAN_CALL_TIMEOUT_MS = 120_000;

/** A track build and an Ask turn may overlap; a burst would only spend the plan's limits faster. */
const PLAN_MAX_CONCURRENT = 2;

/**
 * One for the whole server, not one per client: every route builds its own
 * client, and a limit the plan reported to one of them holds for all.
 */
const planLimit = new PlanLimitLatch();

/** Throws if the subscription flag is set wrongly or anywhere it must not be — see `billingMode`. */
export function claudeClient(env: Readonly<Record<string, string | undefined>> = process.env): ClaudeClient {
  if (resolveClaudeBilling(env).kind === "api") {
    return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  const config = {
    command: "claude",
    commandArgs: [],
    configDir: subscriptionConfigDir(),
    timeoutMs: PLAN_CALL_TIMEOUT_MS,
    maxConcurrent: PLAN_MAX_CONCURRENT,
    limitLatch: planLimit,
  };
  return {
    messages: {
      create: (call, options) => runClaudeCli(call, options?.maxRetries, config),
    },
  };
}
