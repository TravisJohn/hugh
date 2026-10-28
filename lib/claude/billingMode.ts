/**
 * Who pays for Hugh's Claude calls: the paid API key, or the owner's own
 * Claude plan through the locally installed `claude` binary.
 *
 * Subscription mode exists so the owner can explore Hugh on their machine
 * without spending API money. Anthropic permits it only narrowly — an end user
 * signed in to the unmodified Claude Code binary with their own plan — and
 * forbids routing anyone else's requests through plan credentials or deploying
 * it (docs/claude-subscription-local-mode.md §1). Every rule that keeps it
 * inside that line is decided here, once, so the client factory, the usage
 * gate and `logUsage` cannot disagree about which mode a request is in.
 *
 * Pure: the environment is passed in, never read. That is what lets the
 * production stops below be unit-tested in the secretless CI gate.
 */

export type ClaudeBilling =
  | { kind: "api" }
  | { kind: "subscription"; ownerUserId: string };

/** Set to "1" by `npm run dev:subscription` only — never in `.env.local`. */
export const SUBSCRIPTION_FLAG = "HUGH_CLAUDE_SUBSCRIPTION";

/** The one Supabase user the plan may serve. Lives in `.env.local`. */
export const SUBSCRIPTION_OWNER_VAR = "HUGH_SUBSCRIPTION_OWNER_ID";

/**
 * Appended to a model id in `usage_logs.model` when the plan served the call.
 * `lib/pricing.ts` rates these at $0 — a rate class, like
 * `gpt-realtime-mini-text`, never a model id sent to any provider.
 */
export const SUBSCRIPTION_RATE_SUFFIX = "@subscription";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Env = Readonly<Record<string, string | undefined>>;

/** Thrown when the flag is set somewhere it must never take effect, or set wrongly. */
export class SubscriptionModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionModeError";
  }
}

/**
 * The environment that makes subscription mode illegal, or null if none does.
 *
 * `next build` and `next start` run with NODE_ENV=production, and Vercel sets
 * VERCEL and VERCEL_ENV on every build and runtime, preview included. Any one
 * of them means the plan could end up serving someone other than its owner.
 */
function productionMarker(env: Env): string | null {
  if (env.NODE_ENV === "production") return "NODE_ENV=production";
  if (env.VERCEL)                    return "VERCEL";
  if (env.VERCEL_ENV)                return "VERCEL_ENV";
  return null;
}

/**
 * Decide the billing mode, or throw.
 *
 * Off unless the flag is exactly "1". Any other non-empty value throws rather
 * than falling back to the API: someone who typed "true" believes they are on
 * their plan, and quietly billing them would be the one failure this mode
 * exists to prevent. The same reasoning makes a missing owner a throw — a mode
 * with nobody it may serve is a misconfiguration, not an open door.
 */
export function resolveClaudeBilling(env: Env): ClaudeBilling {
  const flag = env[SUBSCRIPTION_FLAG]?.trim() ?? "";
  if (flag === "" || flag === "0") return { kind: "api" };
  if (flag !== "1") {
    throw new SubscriptionModeError(`${SUBSCRIPTION_FLAG} must be "1" or unset, not "${flag}".`);
  }

  const marker = productionMarker(env);
  if (marker) {
    throw new SubscriptionModeError(
      `${SUBSCRIPTION_FLAG} is set where ${marker} is set. Subscription mode is local-only ` +
      `and must never run in a production build or on Vercel.`,
    );
  }

  const owner = env[SUBSCRIPTION_OWNER_VAR]?.trim() ?? "";
  if (!UUID.test(owner)) {
    throw new SubscriptionModeError(
      `${SUBSCRIPTION_OWNER_VAR} must be the Supabase user id the plan may serve.`,
    );
  }

  return { kind: "subscription", ownerUserId: owner.toLowerCase() };
}

/**
 * Whether this user may spend in this mode. Always true on the API; on the
 * plan, only its owner — anyone else signed in to the local server would be
 * using an account that is not theirs (Consumer Terms §2).
 */
export function mayUseClaude(billing: ClaudeBilling, userId: string): boolean {
  return billing.kind === "api" || userId.toLowerCase() === billing.ownerUserId;
}

/**
 * Whether the plan could have served a call to `model`. A Claude plan covers
 * Claude only: an OpenAI or ElevenLabs row is paid for whatever the mode.
 */
export function servableByPlan(model: string): boolean {
  return model.startsWith("claude-");
}

/**
 * The `usage_logs.model` value for a call to `model`. The route still names its
 * model once; the suffix is added here so every row is priced at what it
 * actually cost.
 */
export function usageModelFor(billing: ClaudeBilling, model: string): string {
  return billing.kind === "subscription" && servableByPlan(model) ? `${model}${SUBSCRIPTION_RATE_SUFFIX}` : model;
}
