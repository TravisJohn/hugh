/**
 * What a learner is told when local subscription mode refuses or fails a
 * request (docs/claude-subscription-local-mode.md §4.2, §4.5).
 *
 * Rule 5, twice over. A paid feature switched off on the plan says so and
 * names the way back to it, rather than reading as broken. And each way a
 * plan-served call can fail has its own sentence and status: "your plan is
 * out until Thursday", "Hugh's login has expired" and "Claude was slow" need
 * three different ways out, and none of them is "something went wrong".
 *
 * The sentences are pure and tested; the two `…Response` functions wrap them
 * for route handlers.
 */
import { NextResponse } from "next/server";
import { resolveClaudeBilling } from "../billingMode";
import { subscriptionConfigDir } from "../client";
import { SubscriptionCallError } from "./errors";

export interface PlanReply {
  status: number;
  message: string;
  /** Seconds until the plan's limit resets, when the plan said. */
  retryAfter?: number;
}

const LOGIN_COMMAND = "npm run subscription:login";
const PAID_START_COMMAND = "npm run dev";

/** "Thursday 3:45 pm", in the server's time zone — which, locally, is the owner's. */
function formatReset(resetsAt: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-AU", { weekday: "long", hour: "numeric", minute: "2-digit", timeZone })
    .format(resetsAt);
}

export function describePlanFailure(
  error: SubscriptionCallError,
  context: { now: Date; configDir: string; timeZone?: string },
): PlanReply {
  switch (error.reason) {
    case "limit_reached": {
      const limit = "Your Claude plan's usage limit has been reached.";
      const notPaid = "Hugh did not switch to paid usage.";
      const resetsAt = error.resetsAt;
      if (!resetsAt || resetsAt <= context.now) {
        return { status: 429, message: `${limit} ${notPaid} Try again once it resets.` };
      }
      return {
        status: 429,
        message: `${limit} It resets ${formatReset(resetsAt, context.timeZone)}. ${notPaid}`,
        retryAfter: Math.ceil((resetsAt.getTime() - context.now.getTime()) / 1000),
      };
    }
    case "signed_out":
      return {
        status: 503,
        message: `Hugh's Claude plan login is missing or has expired (Hugh looks in ${context.configDir}). ` +
          `Run ${LOGIN_COMMAND} to sign in, then try again.`,
      };
    case "billed_to_key":
      return {
        status: 503,
        message: "Claude Code tried to use an API key instead of your Claude plan, so Hugh stopped it before it " +
          `sent the request. Run ${LOGIN_COMMAND} to sign in to the plan again.`,
      };
    case "model_unavailable":
      return {
        status: 503,
        message: "Your Claude plan won't serve the model this feature uses, and Hugh doesn't swap models on its own. " +
          `Start Hugh with ${PAID_START_COMMAND} to use it (paid).`,
      };
    case "timeout":
      return { status: 504, message: "Claude didn't answer in time, so Hugh stopped waiting. Please try again." };
    case "failed":
      return { status: 502, message: "Claude Code couldn't answer this request. Please try again; the server log says why." };
  }
}

export function paidServiceOffMessage(feature: string): string {
  return `${feature} is off while Hugh runs on your Claude plan, which covers Claude only. ` +
    `Start Hugh with ${PAID_START_COMMAND} to use it (paid).`;
}

/**
 * For a route that pays OpenAI or ElevenLabs: null on the API, a refusal on
 * the plan. Called before the usage gate, so a refused request reserves
 * nothing. A misconfigured flag throws, as it does everywhere it is read.
 */
export function paidServiceOffResponse(
  feature: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): NextResponse | null {
  if (resolveClaudeBilling(env).kind === "api") return null;
  return NextResponse.json({ error: paidServiceOffMessage(feature) }, { status: 503 });
}

/** The reply for a failed plan-served call, or null when `error` is anything else. */
export function planFailureResponse(error: unknown, now: Date = new Date()): NextResponse | null {
  if (!(error instanceof SubscriptionCallError)) return null;
  // The learner gets the sentence; the log keeps Claude Code's own words,
  // which never include the prompt or the reply (see errors.ts).
  console.warn(`[subscription] ${error.reason}: ${error.message}`);
  const reply = describePlanFailure(error, { now, configDir: subscriptionConfigDir() });
  return NextResponse.json(
    { error: reply.message, retryAfter: reply.retryAfter },
    { status: reply.status, headers: reply.retryAfter ? { "Retry-After": String(reply.retryAfter) } : undefined },
  );
}
