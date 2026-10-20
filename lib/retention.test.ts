// The retention windows exist twice: as TypeScript constants that the app shows
// to learners, and as SQL intervals in the pg_cron jobs that actually delete.
// If those drift, /privacy states one number while the database enforces
// another. These tests read the migration and hold the two together.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETENTION_DAYS } from "./retention";

// Every migration that schedules a retention job. Migrations are forward-only,
// so a new expiry lands in a new file rather than an edit to 052.
const RETENTION_MIGRATIONS = ["052_retention_jobs.sql", "059_review_quizzes.sql"];
const MIGRATION = RETENTION_MIGRATIONS
  .map(f => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8"))
  .join("\n");

/** The body of one cron.schedule call, found by its job name. */
function jobBody(jobName: string): string {
  const match = MIGRATION.match(
    new RegExp(`cron\\.schedule\\(\\s*'${jobName}'[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`),
  );
  if (!match) {
    throw new Error(`No retention migration has a cron.schedule for '${jobName}'.`);
  }
  return match[1];
}

function intervalDays(body: string): number {
  const match = body.match(/interval '(\d+) days'/);
  if (!match) throw new Error(`No "interval 'N days'" in job body:\n${body}`);
  return Number(match[1]);
}

const JOBS = [
  { job: "retention-pending-document-extractions", table: "public.pending_document_extractions", days: RETENTION_DAYS.pendingDocumentExtractions },
  { job: "retention-operation-events",             table: "public.operation_events",             days: RETENTION_DAYS.operationEvents },
  { job: "retention-review-quizzes",               table: "public.review_quizzes",               days: RETENTION_DAYS.reviewQuizzes },
] as const;

describe("retention windows agree between lib/retention.ts and the pg_cron migrations", () => {
  for (const { job, table, days } of JOBS) {
    it(`${job} deletes from ${table} after exactly ${days} days, as /privacy tells learners`, () => {
      const body = jobBody(job);
      expect(body, `${job} must delete from ${table}`).toContain(`DELETE FROM ${table}`);
      expect(intervalDays(body), `update the interval in the migration or RETENTION_DAYS — they must match`).toBe(days);
    });
  }

  it("schedules no deletion job that lib/retention.ts does not know about", () => {
    const scheduled = [...MIGRATION.matchAll(/cron\.schedule\(\s*'([^']+)'/g)].map(m => m[1]);
    expect(scheduled.sort()).toEqual(JOBS.map(j => j.job).sort());
  });

  it("never expires goal_answers, which is kept until the learner deletes it by decision", () => {
    expect(MIGRATION).not.toMatch(/DELETE FROM public\.goal_answers/);
  });
});
