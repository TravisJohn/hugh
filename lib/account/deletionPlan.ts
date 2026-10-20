/**
 * What deleting an account actually removes, and in what order.
 *
 * Part of the privacy pass. Deleting the `auth.users` row cascades all 26
 * user-owned tables (and `pending_document_extractions` via `learning_goals`,
 * `review_quiz_answers` via `review_quizzes`),
 * but two things it does NOT reach:
 *
 *   1. Storage objects. `note-images` and `monitor-documents` are keyed
 *      `<user_id>/<parent_id>/<uuid>.<ext>`, and `storage.objects` has no
 *      foreign key to `auth.users`. Screenshots and résumés would simply stay
 *      in the bucket after the account was gone.
 *
 *   2. `track_generations`. It is `ON DELETE SET NULL` on purpose (migration
 *      048): the record that a model produced a 14-milestone track in 40s
 *      should survive de-identified. But 048's comment says "the learner's
 *      words go with the account, because goal_answers cascades" — true of the
 *      5-whys answers, and NOT true of `input_topic`, which is the topic the
 *      learner typed. That is their words too, and it has to be redacted
 *      rather than left behind.
 *
 * Pure, so the order and the redaction are unit-tested rather than implied by
 * the sequence of statements in a route (CLAUDE.md rule 7).
 */

/** The buckets keyed by user id. Both must be swept before the row goes. */
export const USER_BUCKETS = ["note-images", "monitor-documents"] as const;
export type UserBucket = typeof USER_BUCKETS[number];

export type DeletionStep = "purge-storage" | "redact-generations" | "delete-auth-user";

/**
 * ORDER IS LOAD-BEARING. `delete-auth-user` runs last because the cascade is
 * what makes the earlier steps impossible: once the row is gone,
 * `track_generations.user_id` has already been set to NULL, so there is no way
 * left to find that learner's rows and redact them. The storage sweep is
 * likewise driven from the user id.
 *
 * Deleting first and tidying afterwards is therefore not a slower version of
 * this — it is a version that cannot work.
 */
export const DELETION_ORDER: readonly DeletionStep[] = [
  "purge-storage",
  "redact-generations",
  "delete-auth-user",
] as const;

/**
 * Storage prefix for one learner. The trailing slash matters: without it a
 * prefix match would also catch a different id that merely starts with these
 * characters.
 */
export function storagePrefix(userId: string): string {
  return `${userId}/`;
}

/**
 * The columns of `track_generations` that carry learner content.
 *
 * Listed explicitly so the redaction below can be checked against them. Adding
 * a text column to that table without adding it here is the way a future change
 * quietly starts surviving deletion, and the test beside this fails when it
 * happens.
 */
export const LEARNER_CONTENT_COLUMNS = ["input_topic", "milestones_out"] as const;

/** What replaces a learner's words in a retained provenance row. */
export const REDACTED_TOPIC = "[deleted]";

/**
 * The patch applied to every `track_generations` row belonging to the account.
 *
 * The numbers stay. `answer_chars`, `context_uptake`, `milestone_count` and the
 * timings are not personal data and they are the whole reason 048 recorded them
 * separately — they are what lets a deletion remove the words without blinding
 * the eval. `input_intact` goes false so the loss is visible in a query rather
 * than silent: the replay harness selects `WHERE input_intact`, and a report can
 * say "6 of these 40 rows no longer have their input".
 */
export function generationsRedaction(): Record<string, unknown> {
  return {
    input_topic:    REDACTED_TOPIC,
    milestones_out: null,
    input_intact:   false,
  };
}

/** Counts returned by a completed deletion, for the caller to report. */
export interface DeletionReceipt {
  userId:            string;
  storageObjects:    number;
  generationsRedacted: number;
}

/** One line a human can read, for a log or an admin toast. */
export function summariseDeletion(r: DeletionReceipt): string {
  return `Deleted ${r.userId}: ${r.storageObjects} stored file(s) removed, ` +
         `${r.generationsRedacted} provenance row(s) de-identified, account and all owned rows dropped.`;
}
