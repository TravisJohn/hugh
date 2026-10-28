/**
 * Why a plan-served Claude call did not produce a reply.
 *
 * One class with a reason rather than a hierarchy: the routes need to choose a
 * status and a sentence (rule 5 — a failure needs its own copy and its own way
 * out), and a reason is the one thing they switch on. Messages carry Claude
 * Code's own diagnostic text, never the learner's prompt or the model's reply.
 */
export type SubscriptionFailure =
  /** The binary used an API key instead of the plan. Never retried. */
  | "billed_to_key"
  /** The Hugh-only login is missing or expired: run `npm run subscription:login`. */
  | "signed_out"
  /** A 5-hour, weekly or model limit was hit, or paid extra usage would have been used. */
  | "limit_reached"
  /** The plan would not serve the requested model id. */
  | "model_unavailable"
  /** The process outlived its time budget and was stopped. */
  | "timeout"
  /** Anything else: the CLI is missing, crashed, or returned something unreadable. */
  | "failed";

export class SubscriptionCallError extends Error {
  constructor(
    readonly reason: SubscriptionFailure,
    message: string,
    /** When the plan limit resets, if the CLI said. Only set for `limit_reached`. */
    readonly resetsAt: Date | null = null,
  ) {
    super(message);
    this.name = "SubscriptionCallError";
  }
}
