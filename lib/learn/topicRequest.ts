/**
 * The request box on the course picker (PRD-narrow-learn.md, row 6). A learner
 * who wants a subject the catalog doesn't have can say so in one short line.
 * Travis reads requests in /admin to choose the next packs.
 *
 * A request makes no model call and builds nothing. It is stored and read,
 * never sent to a prompt, so it needs normalising only to stay one tidy line:
 * `normalizeTopic` does that, and this module adds the request's own length
 * and daily limit. Migration 061 holds the same length in the table.
 *
 * Pure: the client and the route share these rules, so they cannot disagree.
 */
import { normalizeTopic } from "./topicInput";

/** Ceiling on a request, in characters. Migration 061's CHECK says the same. */
export const MAX_REQUEST_CHARS = 120;

/** Requests one learner may send in any 24 hours. Enough to name a few subjects, not to fill the table. */
export const DAILY_REQUEST_LIMIT = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RequestRejection = "empty" | "too_long" | "daily_limit";

export type RequestCheck =
  | { ok: true;  text: string }
  | { ok: false; rejection: "empty" | "too_long" };

export function checkRequest(raw: unknown): RequestCheck {
  const text = normalizeTopic(typeof raw === "string" ? raw : "");
  if (!text)                            return { ok: false, rejection: "empty" };
  if (text.length > MAX_REQUEST_CHARS) return { ok: false, rejection: "too_long" };
  return { ok: true, text };
}

/** Where the rolling 24-hour window starts, for counting a learner's recent requests. */
export function requestWindowStart(now: Date): Date {
  return new Date(now.getTime() - DAY_MS);
}

/** Whether one more request fits, given how many this learner sent in the window. */
export function mayRequestAnother(sentInWindow: number): boolean {
  return sentInWindow < DAILY_REQUEST_LIMIT;
}

export const REQUEST_REJECTION_MESSAGE: Record<RequestRejection, string> = {
  empty:       "Type the subject you'd like Hugh to teach.",
  too_long:    `Keep it to ${MAX_REQUEST_CHARS} characters: the name of a subject is enough.`,
  daily_limit: `You've sent ${DAILY_REQUEST_LIMIT} requests today. Hugh reads every one, and you can send more tomorrow.`,
};
