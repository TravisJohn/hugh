import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  OPERATIONS,
  OPERATION_IDS,
  RETIRED_OPERATION_IDS,
  OPERATION_OUTCOMES,
  CLIENT_REPORTABLE_IDS,
  SILENT_FAILURE_IDS,
  isOperationId,
  isOperationOutcome,
  operationById,
  type OperationId,
  type OperationOutcome,
} from "./operations";

// ── Exhaustiveness ──────────────────────────────────────────────────────────
// The invariant that matters most, and it is enforced twice over.
//
// This Record is typed `Record<OperationId, true>`, so TypeScript refuses to
// compile if a union member is missing a key, or if a key names something that
// is not in the union. That is the compile-time half. The runtime half below
// compares its keys against OPERATIONS, which catches the remaining case: a
// union member and a registry entry drifting apart.
//
// Together they mean an operation cannot exist in the type system without
// existing in the registry, or vice versa.

const EVERY_OPERATION: Record<OperationId, true> = {
  "track.build":      true,
  "track.retry":      true,
  "track.refine":     true,
  "track.extract":    true,
  "track.summary":    true,
  "topic.gate":       true,
  "quiz.generate":    true,
  "mastery.evaluate": true,
  "mastery.recap":    true,
  "mastery.session":  true,
  "mastery.realtime": true,
  "ask.chat":         true,
  "ask.summarize":    true,
  "ask.verify":       true,
  "ask.coverage":     true,
  "code.chat":        true,
  "code.drill":       true,
  "cloud.chat":       true,
  "notes.coach":      true,
  "notes.summarize":  true,
  "voice.speak":      true,
  "answers.forget":   true,
};

const EVERY_OUTCOME: Record<OperationOutcome, true> = {
  ok:      true,
  failed:  true,
  refused: true,
};

describe("the registry is exhaustive", () => {
  it("registers every id in the OperationId union, and nothing more", () => {
    expect([...OPERATION_IDS].sort()).toEqual(Object.keys(EVERY_OPERATION).sort());
  });

  it("lists every outcome in the OperationOutcome union, and nothing more", () => {
    expect([...OPERATION_OUTCOMES].sort()).toEqual(Object.keys(EVERY_OUTCOME).sort());
  });

  it("keeps OPERATION_IDS in step with OPERATIONS, in the same order", () => {
    // Order is the display order in the admin panel, so the derived list must
    // not quietly re-sort it.
    expect(OPERATION_IDS).toEqual(OPERATIONS.map(o => o.id));
  });
});

// ── Shape ───────────────────────────────────────────────────────────────────

describe("the registry itself", () => {
  it("has no duplicate ids, since an id is a database key", () => {
    expect(new Set(OPERATION_IDS).size).toBe(OPERATION_IDS.length);
  });

  it("uses ids that are safe as stored keys", () => {
    // Lowercase `domain.action` only: these are written to the database and
    // compared as strings, so a stray space or capital becomes a second
    // operation that renders nowhere.
    for (const id of OPERATION_IDS) expect(id).toMatch(/^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/);
  });

  it("gives every operation a label and a description worth reading", () => {
    for (const op of OPERATIONS) {
      expect(op.label.length).toBeGreaterThan(0);
      // The description is what the next person adding an operation copies the
      // shape of. An empty one teaches them nothing.
      expect(op.description.length).toBeGreaterThan(20);
    }
  });

  it("derives every domain from its own id prefix", () => {
    // The two could drift silently, and a mismatched domain would group an
    // operation under a heading it does not belong to.
    for (const op of OPERATIONS) {
      expect(op.domain).toBe(op.id.split(".")[0]);
    }
  });
});

// ── The two flags that carry meaning ────────────────────────────────────────

describe("clientReportable — the beacon's allowlist", () => {
  it("admits track.build and nothing else", () => {
    // The beacon is a client-writable path into a system table. It exists for
    // exactly one signal: useTrackStatusWatch's hard timeout, which is the
    // only evidence that an after() invocation died without writing a status.
    // Widening this list widens what a browser can put in the database.
    expect(CLIENT_REPORTABLE_IDS).toEqual(["track.build"]);
  });

  it("agrees with the flag on each definition", () => {
    const flagged = OPERATIONS.filter(o => o.clientReportable).map(o => o.id);
    expect(CLIENT_REPORTABLE_IDS).toEqual(flagged);
  });
});

describe("failureIsSilent — the failures nobody sees", () => {
  it("marks topic.gate, because it fails open", () => {
    // A classifier outage returns "in domain" and the request proceeds. The
    // learner sees nothing wrong, so a gate that has stopped gating is
    // indistinguishable from one that is working. This flag is how the panel
    // knows to rank it first.
    expect(SILENT_FAILURE_IDS).toContain("topic.gate");
  });

  it("does not mark the operations whose failure the learner watches happen", () => {
    // A failed track build shows a red card and a Rebuild button; a failed
    // quiz shows an error. Those are loud, and treating them as silent would
    // bury the one that isn't.
    expect(SILENT_FAILURE_IDS).not.toContain("track.build");
    expect(SILENT_FAILURE_IDS).not.toContain("track.retry");
    expect(SILENT_FAILURE_IDS).not.toContain("quiz.generate");
    expect(SILENT_FAILURE_IDS).not.toContain("mastery.evaluate");
    expect(SILENT_FAILURE_IDS).not.toContain("ask.chat");
    // The answers deletion reports both of its failure stages to the learner
    // and changes nothing when the first one fails, so a silent half-delete
    // is not a state this can reach.
    expect(SILENT_FAILURE_IDS).not.toContain("answers.forget");
  });

  it("agrees with the flag on each definition", () => {
    const flagged = OPERATIONS.filter(o => o.failureIsSilent).map(o => o.id);
    expect(SILENT_FAILURE_IDS).toEqual(flagged);
  });
});

// ── Guards ──────────────────────────────────────────────────────────────────

describe("isOperationId / isOperationOutcome / operationById", () => {
  it("accepts a registered id and refuses anything else", () => {
    expect(isOperationId("track.build")).toBe(true);
    expect(isOperationId("track.destroy")).toBe(false);
    expect(isOperationId("")).toBe(false);
    expect(isOperationId(null)).toBe(false);
    expect(isOperationId(undefined)).toBe(false);
    expect(isOperationId(42)).toBe(false);
  });

  it("refuses an id that differs only in case or spacing", () => {
    // These would be accepted by a loose comparison and stored as a second,
    // invisible operation.
    expect(isOperationId("Track.Build")).toBe(false);
    expect(isOperationId(" track.build")).toBe(false);
    expect(isOperationId("track.build ")).toBe(false);
  });

  it("accepts the three outcomes and refuses near-misses", () => {
    expect(isOperationOutcome("ok")).toBe(true);
    expect(isOperationOutcome("failed")).toBe(true);
    expect(isOperationOutcome("refused")).toBe(true);
    expect(isOperationOutcome("error")).toBe(false);
    expect(isOperationOutcome("success")).toBe(false);
    expect(isOperationOutcome(null)).toBe(false);
  });

  it("returns null rather than throwing for an unknown id", () => {
    expect(operationById("nope")).toBeNull();
    expect(operationById("topic.gate")?.label).toBe("Topic domain gate");
  });
});

// ── The registry and the code must agree ────────────────────────────────────
//
// The Stage 1 seam, now closed. This is the test that stops the two drifting,
// and it mirrors the registry-to-pages scan in lib/monitor/features.test.ts.
//
// An operation recorded but not registered writes rows the panel never renders
// — spend on a blind spot. An operation registered but never recorded shows a
// permanently empty row that reads as "never happened" when the truth is
// "never measured", which is the more dangerous of the two: it is a claim of
// health backed by no evidence.

/** Every `recordOperation({ … operation: "…" })` literal in the source tree. */
function instrumentedOperations(dirs: readonly string[]): Set<string> {
  const found = new Set<string>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);

      if (statSync(path).isDirectory()) {
        // Skip this module's own directory: record.ts defines the function and
        // the tests quote ids, neither of which is instrumentation.
        if (entry === "observability") continue;
        walk(path);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;

      const source = readFileSync(path, "utf8");
      let from = source.indexOf("recordOperation(");

      while (from !== -1) {
        const next   = source.indexOf("recordOperation(", from + 1);
        // Read only as far as the next call, so one call site cannot claim the
        // id belonging to the one after it.
        const window = source.slice(from, next === -1 ? from + 400 : Math.min(next, from + 400));
        const match  = /operation:\s*["']([^"']+)["']/.exec(window);
        if (match) found.add(match[1]);
        from = next;
      }
    }
  };

  for (const dir of dirs) walk(dir);
  return found;
}

describe("registry ↔ code", () => {
  const instrumented = instrumentedOperations(["app", "lib"]);

  it("instruments every operation the registry promises", () => {
    const missing = OPERATION_IDS.filter(id => !RETIRED_OPERATION_IDS.includes(id) && !instrumented.has(id));
    expect(missing, `registered but never recorded: ${missing.join(", ")}`).toEqual([]);
  });

  it("registers every operation the code records", () => {
    const unknown = [...instrumented].filter(id => !(OPERATION_IDS as readonly string[]).includes(id));
    expect(unknown, `recorded but not in the registry: ${unknown.join(", ")}`).toEqual([]);
  });

  it("actually found call sites, so a broken scan cannot pass by finding nothing", () => {
    // Without this, deleting every recordOperation call in the app would make
    // the two tests above pass perfectly against an empty set.
    expect(instrumented.size).toBe(OPERATION_IDS.length - RETIRED_OPERATION_IDS.length);
  });
});
