/**
 * Token budget rules — what a request may reserve, and against which ceiling.
 *
 * Not to be confused with `lib/quota.ts`, which caps how many SESSIONS a free
 * learner may start. This module is about tokens and money.
 *
 * Split from `lib/usage.ts` because that module imports `server-only`, which
 * makes it unimportable from a unit test. Everything with a branch in it lives
 * here, pure and dependency-free; `lib/usage.ts` keeps the Supabase talking.
 *
 * The division of labour with Postgres (migration 049) is deliberate:
 *
 *   TypeScript (here)  decides WHAT the limit is and WHAT to reserve.
 *   Postgres (049)     applies it atomically — read, compare and increment in
 *                      one statement, so two concurrent requests cannot both
 *                      pass the same check.
 *
 * The comparison rule therefore exists in exactly one place. Postgres is handed
 * the numbers; it does not know the plan rules, and this module does no
 * arithmetic on shared state.
 */

/** Free users: combined tokens per calendar month. Enforced. */
export const DEFAULT_MONTHLY_TOKEN_LIMIT = 100_000;

/**
 * Pro/admin monthly allowance. Shown on the gauge for awareness but NOT
 * enforced — see `tokenLimitFor`, which returns null for these plans. Changing
 * that is a product decision (it starts refusing paying users), not a bug fix,
 * so this build leaves the existing posture untouched and closes the abuse
 * hole with the rate limit instead, which applies to everyone.
 */
export const PRO_MONTHLY_TOKEN_LIMIT = 1_000_000;

/** Separate monthly character allowances for ElevenLabs, enforced for every plan. */
export const FREE_MONTHLY_TTS_CHARS = 20_000;
export const PRO_MONTHLY_TTS_CHARS = 100_000;

/**
 * Requests per window, per user. Applies to every plan including admin: this
 * is abuse protection, not budgeting, and an admin account with a runaway
 * client spends Travis's money exactly as fast as anyone else's would.
 *
 * A fixed window, not sliding — it permits up to 2x the nominal rate across a
 * window boundary. That is a known and accepted looseness: the purpose is to
 * stop a loop hammering Anthropic, and 2x of 30/min is still nowhere near a
 * runaway. A sliding window would need a row per request, which reintroduces
 * the O(rows) read this whole change exists to delete.
 */
export const RATE_LIMIT_MAX_REQUESTS = 30;
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * How long an unlogged reservation keeps counting against the cap.
 *
 * Reservations are never released, only expired — which is what makes a crashed
 * or platform-killed request self-healing, with nothing needing to run in its
 * failure path. The trade-off is that the TTL must outlast the slowest gated
 * request, or a long track build's own reservation would expire while it is
 * still running and stop protecting the cap.
 *
 * 150s clears the 120s `maxDuration` the track-build routes set, which is the
 * longest anything gated here can legitimately take.
 */
export const RESERVE_TTL_SECONDS = 150;

/** The shape `lib/usage.ts` reads out of `profiles`. */
export interface QuotaProfile {
  plan?:           string | null;
  is_admin?:       boolean | null;
  is_blocked?:     boolean | null;
  approved?:       boolean | null;
  token_limit?:    number | null;
  usage_reset_at?: string | null;
}

/**
 * The token ceiling to enforce, or null for "not enforced".
 *
 * Null is not "zero" and not "unlimited by accident" — it is the explicit
 * current product position for pro and admin, mirrored from the behaviour
 * `checkUsageAllowed` had before this module existed.
 */
export function tokenLimitFor(profile: QuotaProfile | null | undefined): number | null {
  if (profile?.is_admin || profile?.plan === "pro") return null;
  return profile?.token_limit ?? DEFAULT_MONTHLY_TOKEN_LIMIT;
}

export function ttsCharLimitFor(profile: QuotaProfile | null | undefined): number {
  return profile?.is_admin || profile?.plan === "pro"
    ? PRO_MONTHLY_TTS_CHARS
    : FREE_MONTHLY_TTS_CHARS;
}

/** First instant of the current calendar month, as ISO. */
export function startOfMonth(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * The window usage is counted over: the calendar month, unless an admin reset
 * the learner mid-month, in which case the reset wins.
 *
 * This rule was duplicated verbatim in `checkUsageAllowed` and
 * `getUsageSummary`. Two copies of a window rule is how a gauge starts
 * disagreeing with the gate that feeds it.
 */
export function periodStart(
  profile: QuotaProfile | null | undefined,
  now:     Date = new Date(),
): string {
  const monthStart = startOfMonth(now);
  const resetAt    = profile?.usage_reset_at ?? null;
  return resetAt && resetAt > monthStart ? resetAt : monthStart;
}

/**
 * Tokens to reserve before a call whose real cost is not yet known.
 *
 * Reserving is a bet made before the model replies. The bet must be high
 * enough that a burst of concurrent requests cannot slip a large real spend
 * past a cap; it is not reconciled away afterwards, it simply expires
 * (RESERVE_TTL_SECONDS) once the real spend has landed in `tokens_spent`.
 * Over-reserving briefly is therefore the safe direction, and matches the
 * stance `lib/pricing.ts` takes on unknown models: over-state, never hide.
 *
 * Keyed by the same `feature` strings the routes pass to `logUsage`, so the
 * vocabulary a route is gated under is the one it is billed under.
 */
export const RESERVE_ESTIMATES: Record<string, number> = {
  // Track generation — the largest single spend in the product. The goals
  // route gates once under this name and then bills three features off it.
  "tracker/generate":          12_000,
  "dashboard/document-extract": 12_000,
  "tracker/priority":           2_000,
  "dashboard/refine-topic":     1_500,
  "dashboard/refine":           1_500,

  // Long-context tutoring: a capped 20-turn transcript plus a Sonnet reply.
  "learn/chat":                 6_000,
  "learn/summarize":            6_000,
  "review/quiz":                6_000,
  "mastery/evaluate":           6_000,
  "mastery/realtime":           6_000,

  // Vision — a screenshot dominates the input.
  "notes/coach":                8_000,
  "notes/summarize":            3_000,

  // Mid-weight generation off a milestone or diary.
  "tracker/points":             3_000,
  "tracker/summary":            3_000,
  "tracker/verify":             2_000,
  "mastery/recap":              3_000,
  "mastery/session":            2_000,
  "cloud/chat":                 3_000,
  "code/chat":                  3_000,
  "code/generate-drill":        4_000,

  // Short, cheap, classification-shaped. Measured at 743+41 against the live
  // route on 2026-09-04, so 500 under-reserved; a reservation that is under
  // the real cost lets a burst overshoot the cap by the difference.
  "learn/topic-domain":         1_200,

  // TTS spends ElevenLabs characters, not tokens. The shared gate enforces its
  // request rate; reserve_tts separately enforces the monthly character cap.
  "tts":                            0,
};

/**
 * Fallback for a feature with no entry. Deliberately generous rather than
 * zero: an unregistered feature must still consume budget, or adding a route
 * and forgetting this table would silently create an ungated spender.
 */
export const DEFAULT_RESERVE_ESTIMATE = 4_000;

export function reserveEstimateFor(feature: string): number {
  const registered = RESERVE_ESTIMATES[feature];
  return registered === undefined ? DEFAULT_RESERVE_ESTIMATE : registered;
}

/**
 * The tokens one logged call adds to the running total.
 *
 * Trivial by design. It is a plain sum rather than a reconciliation against
 * what was reserved, because a single gated request can log several times —
 * the goals route bills three features off one gate — and subtracting an
 * estimate per log row would under-count by the estimates of the calls that
 * never reserved anything. Reservations expire instead of being cancelled.
 */
export function recordedTokens(tokensIn: number, tokensOut: number): number {
  return Math.max(0, tokensIn) + Math.max(0, tokensOut);
}

export type QuotaDenial = "blocked" | "limit_reached" | "rate_limited" | "unavailable";

export interface QuotaDecision {
  allowed:     boolean;
  reason?:     QuotaDenial;
  /** Seconds until the rate window resets. Only set for "rate_limited". */
  retryAfter?: number;
}

/**
 * Whether a profile may spend at all, before any counter is consulted.
 *
 * Kept separate from the token maths because these two refusals are different
 * kinds of thing: this one is about the account, the other about the budget,
 * and only the second one is worth an atomic round trip. An account that is
 * blocked should never reach Postgres to find that out.
 */
export function accountAllowed(profile: QuotaProfile | null | undefined): QuotaDecision {
  if (profile?.is_blocked)                      return { allowed: false, reason: "blocked" };
  if (!profile?.approved && !profile?.is_admin) return { allowed: false, reason: "blocked" };
  return { allowed: true };
}

/** The HTTP status each refusal maps to. 429 for both "too much" refusals. */
export function statusForDenial(reason: QuotaDenial | undefined): number {
  if (reason === "unavailable") return 503;
  return reason === "limit_reached" || reason === "rate_limited" ? 429 : 403;
}

/** The learner-facing sentence for each refusal. */
export function messageForDenial(reason: QuotaDenial | undefined): string {
  switch (reason) {
    case "unavailable":
      return "Usage checks are temporarily unavailable. Please try again shortly.";
    case "limit_reached":
      return "Monthly usage limit reached. Please contact Travis to reset or upgrade.";
    case "rate_limited":
      return "Too many requests in a short time. Please wait a moment and try again.";
    default:
      return "Your access has been restricted. Please contact support.";
  }
}
