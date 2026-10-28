// ── Who may approve an account ──────────────────────────────────────────────
//
// An account becomes approved in exactly two places: when its owner verifies
// their email (app/auth/confirm), and when an admin approves it in the console.
// Migration 032 already stops a learner's own session writing
// `profiles.approved`, but a server route using the service role bypasses RLS,
// so a route is where a self-approval path would come back. That is what the
// removed /api/auth/self-approve was: an interim open-signup shortcut from when
// Supabase "Confirm email" was off.
//
// This scans the source rather than calling the routes, so a new writer fails
// the build the moment it is written, whatever it is called.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

/** The only files allowed to set `approved` to true, and why. */
const APPROVERS: Record<string, string> = {
  "app/auth/confirm/route.ts": "the owner verified their email",
  "app/api/admin/users/[userId]/route.ts": "an admin approved the account",
};

/** Matches `approved: true` (an object field) and `approved = true` (an assignment). */
const SETS_APPROVED = /\bapproved\s*[:=]\s*true\b/;

/** Every non-test .ts/.tsx file under `rel`, as repo-relative POSIX paths. */
function sourceFilesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(relative(ROOT, full).split(sep).join("/"));
      }
    }
  };
  const start = join(ROOT, rel);
  if (statSync(start, { throwIfNoEntry: false })) walk(start);
  return out;
}

describe("account approval", () => {
  it("is set only by email verification and the admin console, so no one can approve themselves", () => {
    const writers = ["app", "lib"]
      .flatMap(sourceFilesUnder)
      .filter((file) => SETS_APPROVED.test(readFileSync(join(ROOT, file), "utf8")))
      .sort();
    expect(writers).toEqual(Object.keys(APPROVERS).sort());
  });

  it("recognises both ways a route sets the flag", () => {
    expect(SETS_APPROVED.test(".update({ approved: true })")).toBe(true);
    expect(SETS_APPROVED.test("updates.approved   = true;")).toBe(true);
    expect(SETS_APPROVED.test("if (profile.approved === true)")).toBe(false);
    expect(SETS_APPROVED.test("approved: boolean")).toBe(false);
  });
});
