// ── How long Hugh keeps things that are not the learner's own work ──────────
//
// The policy (decided 2026-09-17): what a learner made — diary, tracks, notes,
// Monitor documents, and the 5-whys answers in `goal_answers` — is kept until
// they delete it. Only material that was temporary by design, or that records
// what the system did rather than what the learner wrote, expires.
//
// `goal_answers` is deliberately NOT here. It is the most sensitive text in the
// product, but the replay harness reads it to measure whether track generation
// is improving, and the learner can already read and delete it from the goal
// card. Expiring it would trade that away for a control that already exists.
//
// The deletion itself runs in the database, as pg_cron jobs in migration 052.
// SQL cannot import these numbers, so `retention.test.ts` reads that migration
// and fails the build if the two disagree. Change both, or neither.

export const RETENTION_DAYS = {
  /**
   * Extracted document text waiting for the learner to approve a topic.
   * Approving deletes it at once; this catches the upload that was abandoned.
   */
  pendingDocumentExtractions: 7,

  /**
   * Outcome telemetry. Redacted and capped at write time, so this is tidiness
   * more than privacy. /admin/observability looks back 30 days, well inside it.
   */
  operationEvents: 180,
} as const;
