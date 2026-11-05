// Tests for the three-store join behind /admin/features.
//
// Names describe what is being protected, not what is being called: most of
// these encode a rule from CLAUDE.md that has already been got wrong once
// somewhere in this codebase, or that would produce a quietly wrong number
// rather than a visible error.

import { describe, it, expect } from "vitest";
import {
  buildHealthReport,
  instrumentationOf,
  formatUsd,
  type UsageRow,
  type ActivityRow,
  type OperationRow,
} from "./health";
import { FEATURES, featureById } from "./features";

const usage = (over: Partial<UsageRow> & { feature: string }): UsageRow => ({
  tokens_in: 0, tokens_out: 0, tts_chars: 0, model: null, ...over,
});

const rowFor = (id: string, report: ReturnType<typeof buildHealthReport>) =>
  report.rows.find(r => r.feature.id === id)!;

/**
 * A synthetic feature, used to test the `blind` state.
 *
 * Every real feature now records outcomes, so no live entry can demonstrate
 * this branch. The rule still has to hold: the next surface someone adds will
 * be blind between the day it spends and the day it reports, and that is
 * exactly when the page must not call it healthy. Testing it against a real
 * feature would have made this branch untestable the moment the gap closed.
 */
const syntheticBlind = {
  ...featureById("cases")!,
  id: "synthetic", spendsTokens: true, operations: [],
};

describe("instrumentation state", () => {
  it("separates 'spends money but reports nothing' from 'costs nothing'", () => {
    // The distinction the page is built around: both show no outcome numbers,
    // but only one of them is outstanding work.
    expect(instrumentationOf(syntheticBlind)).toBe("blind");
    expect(instrumentationOf(featureById("cases")!)).toBe("no-spend");
  });

  it("reports zero blind spenders, now that every one is instrumented", () => {
    // The Stage 3 outcome, asserted rather than described. If this ever fails,
    // a spending surface has been added without an operation.
    const report = buildHealthReport([], [], []);
    expect(report.blind.map(f => f.id)).toEqual([]);
    expect(report.instrumentedCount).toBe(report.spendingCount);
  });

  it("calls a feature reporting only when it owns at least one operation id", () => {
    expect(instrumentationOf(featureById("ask")!)).toBe("reporting");
    expect(featureById("ask")!.operations.length).toBeGreaterThan(0);
  });

  it("matches the registry's own count of blind spenders", () => {
    const report = buildHealthReport([], [], []);
    expect(report.spendingCount).toBe(FEATURES.filter(f => f.spendsTokens).length);
    expect(report.instrumentedCount + report.blind.length).toBe(report.spendingCount);
  });
});

describe("spend attribution", () => {
  it("prices each row at its own model rate rather than one blended rate", () => {
    // Hugh's models differ by up to 20x. Summing tokens first and applying one
    // rate is the bug migration 036 and the admin page were both fixed for.
    const report = buildHealthReport([
      usage({ feature: "learn/chat", tokens_in: 1_000_000, model: "claude-sonnet-4-6" }),
      usage({ feature: "learn/chat", tokens_in: 1_000_000, model: "claude-haiku-4-5" }),
    ], [], []);
    // $3.00 (Sonnet) + $1.00 (Haiku) = $4.00. A blended rate would give $6 or $2.
    expect(rowFor("ask", report).spendUsd).toBeCloseTo(4, 5);
  });

  it("routes every spend string of a feature into that one feature", () => {
    // Ask Hugh owns four different route-level strings. The whole point of the
    // registry is that they land on one row.
    const report = buildHealthReport([
      usage({ feature: "learn/chat",     tokens_in: 1_000_000, model: "claude-haiku-4-5" }),
      usage({ feature: "learn/summarize", tokens_in: 1_000_000, model: "claude-haiku-4-5" }),
      usage({ feature: "tracker/verify",  tokens_in: 1_000_000, model: "claude-haiku-4-5" }),
      usage({ feature: "tracker/points",  tokens_in: 1_000_000, model: "claude-haiku-4-5" }),
    ], [], []);
    expect(rowFor("ask", report).spendUsd).toBeCloseTo(4, 5);
  });

  it("surfaces spend that belongs to no feature instead of dropping it", () => {
    // A historic row written by deleted code still cost money. Silently
    // excluding it would make a total the operator reads as complete be wrong.
    const report = buildHealthReport([
      usage({ feature: "interview", tokens_in: 1_000_000, model: "claude-haiku-4-5" }),
    ], [], []);
    expect(report.unattributedSpendUsd).toBeCloseTo(1, 5);
    expect(report.unattributedFeatures).toEqual(["interview"]);
    expect(report.totalSpendUsd).toBeCloseTo(1, 5);
  });

  it("counts unattributed spend in the total, so the total is never understated", () => {
    const report = buildHealthReport([
      usage({ feature: "learn/chat", tokens_in: 1_000_000, model: "claude-haiku-4-5" }),
      usage({ feature: "ghost/route", tokens_in: 1_000_000, model: "claude-haiku-4-5" }),
    ], [], []);
    expect(report.totalSpendUsd).toBeCloseTo(2, 5);
  });

  it.each([
    { feature: "tts", tts_chars: 1000 },
    { feature: "mastery/realtime", tokens_in: 1000, model: "gpt-realtime-mini" },
    { feature: "mastery/recap", tokens_in: 1000, model: "claude-sonnet-4-6" },
    { feature: "mastery/evaluate", tokens_in: 1000, model: "claude-sonnet-4-6" },
  ])("keeps past spend under the retired name $feature on the Mastery row", row => {
    // Nothing logs these names now, but the rows still cost what they cost, so
    // removing a feature must not move its history out of the Mastery line.
    const report = buildHealthReport([usage(row)], [], []);
    expect(rowFor("mastery", report).spendUsd).toBeGreaterThan(0);
    expect(report.unattributedSpendUsd).toBe(0);
  });
});

describe("engagement", () => {
  const act = (feature: string, user_id: string, event_date: string): ActivityRow =>
    ({ feature, user_id, event_date });

  it("counts a learner once however many days they were active", () => {
    const report = buildHealthReport([], [
      act("notes", "u1", "2026-09-01"),
      act("notes", "u1", "2026-09-02"),
      act("notes", "u2", "2026-09-02"),
    ], []);
    expect(rowFor("notes", report).learners).toBe(2);
    expect(rowFor("notes", report).activeDays).toBe(2);
  });

  it("merges both code calendars onto the single Code feature", () => {
    // Code is one codebase behind two activity ids. A learner who drilled and
    // used the sandbox on one day is one learner, one day.
    const report = buildHealthReport([], [
      act("code-drill",   "u1", "2026-09-01"),
      act("code-sandbox", "u1", "2026-09-01"),
    ], []);
    expect(rowFor("code", report).learners).toBe(1);
    expect(rowFor("code", report).activeDays).toBe(1);
  });

  it("ignores an activity id that is not in the registry", () => {
    const report = buildHealthReport([], [act("interview", "u1", "2026-09-01")], []);
    expect(report.rows.every(r => r.learners === 0)).toBe(true);
  });
});

describe("outcomes", () => {
  const op = (operation: string, outcome: OperationRow["outcome"]): OperationRow =>
    ({ operation, outcome });

  it("keeps refused separate from failed", () => {
    // A usage-gate block is the system working. Folding it into failures would
    // make a healthy product look broken and send the operator chasing noise.
    const report = buildHealthReport([], [], [
      op("ask.chat", "ok"), op("ask.chat", "ok"),
      op("ask.chat", "failed"),
      op("ask.chat", "refused"), op("ask.chat", "refused"),
    ]);
    const r = rowFor("ask", report);
    expect([r.ok, r.failed, r.refused, r.attempts]).toEqual([2, 1, 2, 5]);
  });

  it("sums every operation a feature owns onto its one row", () => {
    // Learn owns four operations; the board's health is all of them together.
    const report = buildHealthReport([], [], [
      op("track.build", "ok"), op("track.retry", "ok"),
      op("topic.gate", "refused"), op("answers.forget", "ok"),
    ]);
    expect(rowFor("learn", report).ok).toBe(3);
    expect(rowFor("learn", report).refused).toBe(1);
  });

  it("shows spend with no attempts rather than inventing health", () => {
    // Notes now reports, so this is the "instrumented but idle in this window"
    // case: money was spent, no operation row landed inside the window. The
    // page must render that as 'no attempts', never as a clean bill of health.
    const report = buildHealthReport([usage({ feature: "notes/coach", tokens_in: 100 })], [], []);
    const r = rowFor("notes", report);
    expect(r.instrumentation).toBe("reporting");
    expect(r.attempts).toBe(0);
    expect(r.spendUsd).toBeGreaterThan(0);
  });
});

describe("report shape", () => {
  it("returns one row per registered feature, in registry order", () => {
    const report = buildHealthReport([], [], []);
    expect(report.rows.map(r => r.feature.id)).toEqual(FEATURES.map(f => f.id));
  });

  it("reports zeroes rather than throwing when every store is empty", () => {
    const report = buildHealthReport([], [], []);
    expect(report.totalSpendUsd).toBe(0);
    expect(report.rows.every(r => r.attempts === 0)).toBe(true);
  });
});

describe("currency formatting", () => {
  it("shows sub-cent spend at four places so it never reads as free", () => {
    expect(formatUsd(0.0004)).toBe("$0.0004");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.839)).toBe("$1.84");
  });
});
