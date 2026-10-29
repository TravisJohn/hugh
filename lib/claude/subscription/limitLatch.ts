/**
 * Remembers a reported plan limit until it resets, so later calls are refused
 * without starting Claude Code.
 *
 * Mostly this spares a process start per call while the limit holds — the
 * track builder and the topic gate each retry once. But it also caps a cost:
 * Claude Code reports that a call drew on paid extra usage only alongside the
 * reply, after the request was served. If extra usage were ever switched on
 * for the account, every call past the limit would be billed before the
 * parser could refuse it. With the latch, at most one is.
 *
 * A limit reported without a reset time is not remembered: there would be no
 * honest moment to stop refusing, and the next call simply asks again.
 *
 * Pure: the caller passes the time in.
 */
import { SubscriptionCallError } from "./errors";

export class PlanLimitLatch {
  private until: Date | null = null;

  /** Note `error` if it is a plan limit with a future reset time; ignore anything else. */
  record(error: unknown, now: Date): void {
    if (!(error instanceof SubscriptionCallError) || error.reason !== "limit_reached") return;
    const resetsAt = error.resetsAt;
    if (!resetsAt || resetsAt <= now) return;
    // Keep the later of two limits: a weekly limit outlasts the 5-hour one.
    if (!this.until || resetsAt > this.until) this.until = resetsAt;
  }

  /** The error to refuse a call with while a limit holds, or null once it has reset. */
  refusal(now: Date): SubscriptionCallError | null {
    if (!this.until || now >= this.until) return null;
    return new SubscriptionCallError(
      "limit_reached",
      "The Claude plan reported its limit earlier; Hugh is not starting new calls until it resets.",
      this.until,
    );
  }
}
