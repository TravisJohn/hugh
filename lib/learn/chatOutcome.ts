/**
 * What came back from asking Hugh a question.
 *
 * Two faults on the Ask Hugh screen share one cause, and this module is the
 * shape that fixes both.
 *
 * The first: `data.reply ?? "Sorry, something went wrong. Please try again."`
 * never looked at the status. The server writes real sentences for its
 * refusals — "Monthly usage limit reached. Please contact Travis to reset or
 * upgrade." — and every one of them was thrown away and replaced with a shrug
 * that gives the learner nothing to act on. They press send again, and get the
 * same shrug.
 *
 * The second is quieter and travels further: the substitute was appended to the
 * thread **as a message from Hugh**. From there it is sent back to Claude as
 * its own prior turn on the next question, folded into the checklist rail's
 * coverage reading, written into the downloadable transcript, and — the one
 * that matters — passed to the summariser, whose output the learner saves as a
 * diary entry. Review quizzes may only quote diary entries. So a sentence Hugh
 * never said could end up as the thing a quiz asks about.
 *
 * The fix is structural rather than careful: a failure here carries no `reply`
 * at all, so there is nothing for a caller to append to the conversation even
 * by accident.
 *
 * WHY THIS DOES NOT REUSE `errors/saveOutcome`. That module reads the reply to
 * a save, and its vocabulary is right for saves and wrong here: a 403 on a save
 * means "not your row", while a 403 from this route means "your account is
 * restricted". Same number, different sentence to the person reading it.
 * Sharing the mapping would be a tidier-looking lie. Two domains, two mappings.
 *
 * Pure and dependency-free, so the decision is unit-tested rather than buried
 * in a component (CLAUDE.md rule 7).
 */

/** Why there is no answer. Coarser than a status, because what changes for the
 *  learner is the sentence and whether pressing send again could help. */
export type ChatFailureReason =
  | "signed-out"    // 401 — the session lapsed mid-conversation
  | "restricted"    // 403 — the account is blocked or not yet approved
  | "rate-limited"  // 429 — monthly budget, or too many in a burst
  | "rejected"      // other 4xx — the server understood and declined
  | "server"        // 5xx — Hugh's fault, including a model that failed
  | "unreachable"   // the request never arrived
  | "empty";        // it answered, with nothing in it

export interface ChatFailure {
  reason:   ChatFailureReason;
  /** One sentence for the learner. The server's own, where it wrote one. */
  message:  string;
  /** Whether sending the same question again could plausibly work. */
  canRetry: boolean;
  /** Seconds until a rate limit lifts, when the server said so. */
  retryAfterSeconds: number | null;
}

export type ChatOutcome =
  | { ok: true; reply: string }
  | ({ ok: false } & ChatFailure);

/**
 * The statuses whose body is written for a learner rather than for a log.
 *
 * The usage gate and text-size boundary return learner-facing copy. The
 * route's other refusals are
 * developer shorthand — "Unauthorized", "topic and messages are required",
 * "Failed to generate response" — and must not reach a learner, so they are not
 * listed. A 4xx is not in general a promise that its body is fit to read.
 */
const HUMAN_REFUSAL_STATUSES: readonly number[] = [403, 413, 429, 503];

const FALLBACK: Record<ChatFailureReason, { message: string; canRetry: boolean }> = {
  "signed-out": {
    message:  "You've been signed out, so Hugh didn't get that. Sign in again and your question will send.",
    canRetry: false,
  },
  restricted: {
    message:  "Your access to Hugh is restricted at the moment. Please contact support.",
    canRetry: false,
  },
  "rate-limited": {
    message:  "You've reached your usage limit, so Hugh couldn't answer that one.",
    canRetry: false,
  },
  rejected: {
    message:  "Hugh couldn't take that question.",
    canRetry: false,
  },
  server: {
    message:  "Something went wrong on Hugh's side, so that question didn't get answered. Try sending it again.",
    canRetry: true,
  },
  unreachable: {
    message:  "We couldn't reach Hugh, so that question didn't send. Check your connection and try again.",
    canRetry: true,
  },
  empty: {
    message:  "Hugh didn't answer that one. Try sending it again.",
    canRetry: true,
  },
};

function reasonOfStatus(status: number): ChatFailureReason {
  if (status === 401) return "signed-out";
  if (status === 403) return "restricted";
  if (status === 429 || status === 503) return "rate-limited";
  if (status >= 400 && status < 500) return "rejected";
  return "server";
}

/**
 * Read `retryAfter` off a reply without trusting it.
 *
 * It arrives as JSON, so it can be anything. A negative or non-finite value
 * would render as a countdown that never ends, which is worse than not offering
 * one at all.
 */
function retryAfterOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : null;
}

export interface ChatReplyBody {
  reply?:      unknown;
  error?:      unknown;
  retryAfter?: unknown;
}

/**
 * Decide what the learner sees, given the status and the parsed body.
 *
 * A 2xx carrying no usable reply is a failure, not a blank message from Hugh:
 * appending an empty bubble would put a turn Hugh never took into the history
 * that Claude, the summariser and the quiz all read.
 */
export function chatOutcome(status: number, body: ChatReplyBody | null): ChatOutcome {
  if (status >= 200 && status < 300) {
    const reply = typeof body?.reply === "string" ? body.reply.trim() : "";
    if (reply) return { ok: true, reply };
    return { ok: false, reason: "empty", ...FALLBACK.empty, retryAfterSeconds: null };
  }

  const reason   = reasonOfStatus(status);
  const serverly = typeof body?.error === "string" ? body.error.trim() : "";
  const message  = HUMAN_REFUSAL_STATUSES.includes(status) && serverly
    ? serverly
    : FALLBACK[reason].message;

  return {
    ok:                false,
    reason,
    message,
    canRetry:          FALLBACK[reason].canRetry,
    retryAfterSeconds: retryAfterOf(body?.retryAfter),
  };
}

/**
 * Read a thrown error from the `fetch` itself.
 *
 * The browser throws `TypeError` when the request never reached a server.
 * Anything else was thrown by our own code after the reply arrived, which is
 * Hugh's problem rather than the connection's.
 */
export function chatOutcomeOfThrown(error: unknown): ChatOutcome {
  const reason: ChatFailureReason =
    error instanceof TypeError ? "unreachable" : "server";
  return { ok: false, reason, ...FALLBACK[reason], retryAfterSeconds: null };
}

/**
 * The "come back at" line for a rate limit, or nothing.
 *
 * Kept beside the copy it belongs to rather than composed in the component, and
 * separate from `message` so the server's own sentence is never rewritten —
 * this is added underneath it, not spliced into it.
 */
export function retryHint(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  if (seconds < 60) return `You can try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
  const minutes = Math.ceil(seconds / 60);
  return `You can try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
