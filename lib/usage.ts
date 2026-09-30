import "server-only";
import { NextResponse, after } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { deferOrRun } from "@/lib/afterResponse";
import { isKnownModel } from "@/lib/pricing";
import {
  type QuotaProfile,
  type QuotaDecision,
  type QuotaDenial,
  PRO_MONTHLY_TOKEN_LIMIT,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_SECONDS,
  RESERVE_TTL_SECONDS,
  accountAllowed,
  messageForDenial,
  periodStart,
  recordedTokens,
  reserveEstimateFor,
  statusForDenial,
  tokenLimitFor,
} from "@/lib/tokenBudget";

// Pricing lives in lib/pricing.ts (pure, unit-tested). Re-exported here so the
// many existing `from "@/lib/usage"` importers keep working.
export { estimateCost, totalCost, MODEL_RATES, rateFor } from "@/lib/pricing";
export type { ModelRate, PricedUsageRow } from "@/lib/pricing";

// Budget rules live in lib/tokenBudget.ts (pure, unit-tested), for the same reason.
export { DEFAULT_MONTHLY_TOKEN_LIMIT } from "@/lib/tokenBudget";
export { PRO_MONTHLY_TOKEN_LIMIT };
export type { QuotaDenial } from "@/lib/tokenBudget";

// Sentinel userId used by the interview routes in local dev — not a real
// auth.users row, so usage rows are never written for it.
const DEV_BYPASS_USER_ID = "dev-test-bypass";

const PROFILE_COLUMNS = "plan, is_admin, is_blocked, approved, token_limit, usage_reset_at";

async function readProfile(userId: string): Promise<QuotaProfile | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("user_id", userId)
    .single();
  return data as QuotaProfile | null;
}

/**
 * Record one billable call. `model` is required for any call that spent tokens
 * so the row can be priced at that model's real rate (migration 036); TTS-only
 * rows legitimately omit it.
 *
 * Since migration 049 this also adds the spend to `usage_counters`, the running
 * total the gate compares against. That write is purely additive and knows
 * nothing about what was reserved — a single gated request can log several
 * times, so the reservation is expired on a window rather than cancelled here.
 *
 * TIMING CONTRACT — awaiting this means "the write is scheduled", NOT "the row
 * exists". The write is handed to `after()` so it survives the response: on
 * Vercel the invocation can freeze the moment the response returns, and every
 * one of the ~21 call sites `void`s this promise, so an inline insert can be
 * cut off mid-flight and lost. Since 049 that is not merely an under-reported
 * gauge — `recordAgainstCounter` is what turns the gate's reservation into
 * recorded spend, so a lost write returns budget the learner really spent while
 * the provider bill still arrives. Anything needing the row to exist before it
 * continues must call `writeUsage` directly rather than awaiting this.
 */
export async function logUsage({
  userId,
  feature,
  model,
  tokensIn  = 0,
  tokensOut = 0,
  ttsChars  = 0,
}: {
  userId:     string;
  feature:    string;
  model?:     string;
  tokensIn?:  number;
  tokensOut?: number;
  ttsChars?:  number;
}): Promise<void> {
  if (!tokensIn && !tokensOut && !ttsChars) return;

  // A token-spending row with no known model would be priced at the fallback
  // rate, silently mis-stating spend. Surface it in dev rather than swallow it.
  if (process.env.NODE_ENV !== "production" && (tokensIn || tokensOut) && !isKnownModel(model)) {
    console.warn(
      `[usage] "${feature}" logged ${tokensIn + tokensOut} tokens with ` +
      `${model ? `unrecognised model "${model}"` : "no model"} — cost will fall back to Sonnet rates. ` +
      `Add it to MODEL_RATES in lib/pricing.ts.`
    );
  }

  // The interview routes use a sentinel userId in local dev. It isn't a real
  // auth.users row, so the insert would fail the FK — skip it rather than
  // emit a misleading error on every dev request.
  if (userId === DEV_BYPASS_USER_ID) return;

  await deferOrRun(
    after,
    () => writeUsage({ userId, feature, model, tokensIn, tokensOut, ttsChars }),
    (stage, err) => {
      // Neither branch may throw — see the timing contract above. `schedule`
      // means the deferral itself is broken, which is worth distinguishing:
      // the write still happened, just on the request's critical path.
      console.error(`[usage] ${stage} failed for "${feature}" (${userId}):`, err);
    },
  );
}

/**
 * The write itself: the `usage_logs` row, then the counter the gate reads.
 *
 * Separated from `logUsage` so the deferral wraps exactly the part that can be
 * lost, and so a caller that genuinely needs the row to exist before continuing
 * has something to await. Ordering matters — `usage_logs` is the authoritative
 * record and seeds the next period, so it is written first and the counter
 * update follows it.
 */
async function writeUsage({
  userId,
  feature,
  model,
  tokensIn,
  tokensOut,
  ttsChars,
}: {
  userId:    string;
  feature:   string;
  model?:    string;
  tokensIn:  number;
  tokensOut: number;
  ttsChars:  number;
}): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.from("usage_logs").insert({
    user_id:    userId,
    feature,
    model:      model ?? null,
    tokens_in:  tokensIn,
    tokens_out: tokensOut,
    tts_chars:  ttsChars,
  });

  // A rejected insert must not vanish: the spend has already happened and this
  // is the only record of it. Logging is the right level of handling — usage
  // accounting must never fail a user request.
  if (error) {
    console.error(`[usage] failed to log "${feature}" for ${userId}:`, error.message);
  }

  await recordAgainstCounter(userId, feature, tokensIn, tokensOut);
}

/**
 * Add this call's real spend to the period counter the gate reads.
 *
 * Runs post-response behind `logUsage`, so its extra profile read costs the
 * learner no latency. The read is needed because the counter is keyed
 * by period, and the period depends on `usage_reset_at` — a rule that lives in
 * `lib/tokenBudget.ts` and is deliberately not duplicated into SQL.
 *
 * A failure here leaves the spend uncounted by the gate until the next period
 * seeds itself from `usage_logs`, which stays the authoritative record either
 * way. It must never throw: accounting is not the request.
 */
async function recordAgainstCounter(
  userId:    string,
  feature:   string,
  tokensIn:  number,
  tokensOut: number,
): Promise<void> {
  const tokens = recordedTokens(tokensIn, tokensOut);
  // TTS-only rows spend characters, not tokens, and reserve none. The monthly
  // cap has never counted them; the rate limit is what governs that route.
  if (tokens === 0) return;

  try {
    const profile  = await readProfile(userId);
    const supabase = createServiceClient();
    const { error } = await supabase.rpc("record_usage", {
      p_user_id:      userId,
      p_period_start: periodStart(profile),
      p_tokens:       tokens,
    });
    if (error) {
      console.error(`[usage] failed to count "${feature}" for ${userId}:`, error.message);
    }
  } catch (err) {
    console.error(`[usage] counter write threw for "${feature}"`, err);
  }
}

/**
 * Reserve this request's estimated cost, atomically, and say whether it may run.
 *
 * `feature` is required, and is the same string the route passes to `logUsage`.
 * `estimate`, when supplied by trusted server code, reserves the assembled
 * prompt and output allowance. Otherwise the feature estimate applies.
 * Every billable caller requires a successful atomic reservation.
 */
export async function checkUsageAllowed(
  userId:  string,
  feature: string,
  estimate?: number,
): Promise<QuotaDecision> {
  if (estimate !== undefined && (!Number.isSafeInteger(estimate) || estimate < 0)) throw new Error("Invalid usage reservation");
  const profile = await readProfile(userId);

  // The account check comes first and never touches the counter: a blocked or
  // unapproved account should not reach Postgres to find that out, and this
  // refusal must hold even if the reservation machinery is unavailable.
  const account = accountAllowed(profile);
  if (!account.allowed) return account;

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc("reserve_usage", {
      p_user_id:       userId,
      p_period_start:  periodStart(profile),
      p_estimate:      estimate ?? reserveEstimateFor(feature),
      p_token_limit:   tokenLimitFor(profile),
      p_max_requests:  RATE_LIMIT_MAX_REQUESTS,
      p_rate_window_s: RATE_LIMIT_WINDOW_SECONDS,
      p_reserve_ttl_s: RESERVE_TTL_SECONDS,
    });

    if (error) {
      console.error(`[usage] reserve_usage unavailable for ${userId}:`, error.message);
      return { allowed: false, reason: "unavailable", retryAfter: 30 };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (row?.granted === true) return { allowed: true };
    if (row?.granted === false && (row.reason === "limit_reached" || row.reason === "rate_limited")) {
      return {
        allowed: false,
        reason: row.reason as QuotaDenial,
        retryAfter: row.retry_after ?? undefined,
      };
    }
    console.error(`[usage] reserve_usage returned an invalid decision for ${userId}`);
  } catch (error) {
    console.error(`[usage] reserve_usage threw for ${userId}:`, error);
  }
  return { allowed: false, reason: "unavailable", retryAfter: 30 };
}

/**
 * Route-handler gate for every billable AI/TTS endpoint (HIGH-03/HIGH-05 —
 * deployment readiness audit). Wraps `checkUsageAllowed` (which covers
 * `is_blocked`/`approved`, the token budget and the request rate) into the
 * 403/429 JSON response every route should return on rejection.
 *
 * Usage:
 *   const gate = await enforceUsageGate(userId, "learn/chat");
 *   if (gate) return gate;
 */
export async function enforceUsageGate(
  userId:  string,
  feature: string,
  estimate?: number,
): Promise<NextResponse | null> {
  const { allowed, reason, retryAfter } = await checkUsageAllowed(userId, feature, estimate);
  if (allowed) return null;

  // Retry-After is what makes a rate limit actionable rather than a wall: the
  // client is told when to come back instead of guessing (Rule 5 — a failure
  // needs its own way out).
  const headers = retryAfter ? { "Retry-After": String(retryAfter) } : undefined;

  return NextResponse.json(
    { error: messageForDenial(reason), retryAfter },
    { status: statusForDenial(reason), headers },
  );
}

export interface UsageSummary {
  tokens: { used: number; limit: number; pct: number };
}

/**
 * Monthly token consumption for the header gauge. Everyone has an allowance:
 * free uses the enforced cap; pro/admin get the larger (display-only) allowance.
 *
 * Reads `usage_logs`, not `usage_counters`, on purpose: the gauge should show
 * what the learner has actually spent, not what is momentarily reserved by
 * in-flight requests. It shares `periodStart` with the gate, so the two cannot
 * disagree about when the month began.
 */
export async function getUsageSummary(userId: string): Promise<UsageSummary> {
  const supabase = createServiceClient();
  const profile  = await readProfile(userId);

  const { data: logs } = await supabase
    .from("usage_logs")
    .select("tokens_in, tokens_out")
    .eq("user_id", userId)
    .gte("created_at", periodStart(profile));

  const used  = (logs ?? []).reduce((s, r) => s + (r.tokens_in ?? 0) + (r.tokens_out ?? 0), 0);
  // The gauge shows the pro allowance for pro/admin even though it is not
  // enforced (tokenLimitFor returns null for them) — awareness, not a cap.
  const limit = tokenLimitFor(profile) ?? PRO_MONTHLY_TOKEN_LIMIT;
  const pct   = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  return { tokens: { used, limit, pct } };
}
