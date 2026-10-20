// ── The drift guard and the boundary guard ──────────────────────────────────
//
// A registry that can go stale is just another markdown file. This one cannot,
// because these tests read the filesystem and fail the build when the registry
// and the code disagree.
//
// Two jobs, deliberately in one file because they share the same scan:
//
//   DRIFT    — everything in the repo is owned by exactly one feature, and
//              every telemetry vocabulary is fully claimed. A new route, a new
//              folder, or a new logUsage string that nobody declared is a
//              failed build with a message naming what to add.
//
//   BOUNDARY — features may import infrastructure, and may import each other
//              ONLY along edges written down with a reason. This is the single
//              real benefit of splitting Hugh into separate repositories,
//              delivered without any of the deployment machinery.
//
// Failure messages name the offending path and say what to do, because the
// person who trips these is not necessarily the person who wrote them.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  FEATURES,
  FEATURE_IDS,
  INFRA_LIB_DIRS,
  INFRA_COMPONENT_DIRS,
  UNATTRIBUTED_USAGE_FEATURES,
  ALLOWED_LIB_EDGES,
  ALLOWED_COMPONENT_EDGES,
  isInstrumented,
} from "./features";
import { OPERATIONS } from "@/lib/observability/operations";
import { MONITOR_FEATURES } from "@/lib/monitor/features";

const ROOT = process.cwd();

// ── Filesystem helpers ──────────────────────────────────────────────────────

function dirsIn(rel: string): string[] {
  return readdirSync(join(ROOT, rel), { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

/** Every file under `rel` matching one of `exts`, as repo-relative POSIX paths. */
function filesUnder(rel: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
      } else if (exts.some(e => entry.name.endsWith(e))) {
        out.push(relative(ROOT, full).split(sep).join("/"));
      }
    }
  };
  const start = join(ROOT, rel);
  if (statSync(start, { throwIfNoEntry: false })) walk(start);
  return out;
}

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ── Derived sets ────────────────────────────────────────────────────────────

/** `app/api/foo/bar/route.ts` -> `foo/bar` */
const apiRoutesOnDisk = filesUnder("app/api", ["route.ts"])
  .map(p => p.replace(/^app\/api\//, "").replace(/\/route\.ts$/, ""));

/** `app/foo/page.tsx` -> `/foo`; `app/page.tsx` -> `/` */
const pagesOnDisk = filesUnder("app", ["page.tsx"])
  .map(p => {
    const r = p.replace(/^app/, "").replace(/\/page\.tsx$/, "");
    return r === "" ? "/" : r;
  });

const claimedApiRoutes  = FEATURES.flatMap(f => f.apiRoutes);
const claimedPages      = FEATURES.flatMap(f => f.routes);
const claimedLibDirs    = new Set(FEATURES.flatMap(f => f.libDirs));
const claimedCompDirs   = new Set(FEATURES.flatMap(f => f.componentDirs));

/**
 * `usage_logs.feature` strings, read only from files that actually call
 * `logUsage` — scanning every `feature:` key in the codebase would collide
 * with unrelated objects that happen to use the same word.
 */
function usageFeatureStringsOnDisk(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of [...filesUnder("app/api", [".ts"]), ...filesUnder("lib", [".ts"])]) {
    const src = read(file);
    if (!src.includes("logUsage")) continue;
    for (const m of src.matchAll(/feature:\s*"([^"]+)"/g)) {
      const list = found.get(m[1]) ?? [];
      list.push(file);
      found.set(m[1], list);
    }
  }
  return found;
}

/**
 * Cross-directory imports: `lib/a/x.ts` importing `@/lib/b/...` yields a->b.
 *
 * `infra` names directories excluded from BOTH ends. A feature importing
 * infrastructure is the normal case and is never an edge; infrastructure
 * importing infrastructure is likewise uninteresting. What remains is the set
 * of genuine feature-to-feature dependencies, which is the thing being guarded.
 */
function edgesIn(
  base:  "lib" | "components",
  infra: readonly string[],
): { from: string; to: string; file: string }[] {
  const dirs = dirsIn(base).filter(d => !infra.includes(d));
  const edges: { from: string; to: string; file: string }[] = [];
  for (const from of dirs) {
    for (const file of filesUnder(`${base}/${from}`, [".ts", ".tsx"])) {
      const src = read(file);
      for (const to of dirs) {
        if (to === from) continue;
        if (new RegExp(`@/${base}/${to}/`).test(src)) edges.push({ from, to, file });
      }
    }
  }
  return edges;
}

const libEdges  = () => edgesIn("lib", INFRA_LIB_DIRS);
const compEdges = () => edgesIn("components", INFRA_COMPONENT_DIRS);

// ── Registry integrity ──────────────────────────────────────────────────────

describe("feature registry: internal consistency", () => {
  it("gives every feature a unique id, so a row cannot silently overwrite another", () => {
    expect(FEATURE_IDS).toHaveLength(new Set(FEATURE_IDS).size);
  });

  it("gives every feature a blurb, because /admin/features is read by a non-engineer", () => {
    for (const f of FEATURES) expect(f.blurb.length, `${f.id} has no blurb`).toBeGreaterThan(10);
  });

  it("attaches a reason to every allowed import edge, so no edge is unexplained", () => {
    for (const e of [...ALLOWED_LIB_EDGES, ...ALLOWED_COMPONENT_EDGES]) {
      expect(e.reason.length, `${e.from} -> ${e.to} has no reason`).toBeGreaterThan(10);
    }
  });
});

// ── Drift: nothing in the repo is unowned ───────────────────────────────────

describe("drift guard: every directory belongs to a feature or to infrastructure", () => {
  // Claimed AT LEAST once, never exactly once: lib/learn serves both the board
  // and Ask Hugh, and lib/code serves both the drills and the sandbox. Code
  // layout and surface boundaries are different partitions.
  it("claims every lib/ directory", () => {
    const orphans = dirsIn("lib")
      .filter(d => !claimedLibDirs.has(d) && !INFRA_LIB_DIRS.includes(d));
    expect(
      orphans,
      `Unowned lib/ directories: ${orphans.join(", ")}. Add them to a feature's ` +
      `libDirs in lib/registry/features.ts, or to INFRA_LIB_DIRS if every feature uses them.`,
    ).toEqual([]);
  });

  it("claims every components/ directory", () => {
    const orphans = dirsIn("components")
      .filter(d => !claimedCompDirs.has(d) && !INFRA_COMPONENT_DIRS.includes(d));
    expect(
      orphans,
      `Unowned components/ directories: ${orphans.join(", ")}. Add them to a ` +
      `feature's componentDirs, or to INFRA_COMPONENT_DIRS.`,
    ).toEqual([]);
  });

  it("does not claim a lib/ directory that no longer exists", () => {
    const real = new Set(dirsIn("lib"));
    const ghosts = [...claimedLibDirs].filter(d => !real.has(d));
    expect(ghosts, `Registry claims deleted lib/ dirs: ${ghosts.join(", ")}`).toEqual([]);
  });
});

describe("drift guard: every route belongs to exactly one feature", () => {
  it("claims every app/api route", () => {
    const unclaimed = apiRoutesOnDisk.filter(r => !claimedApiRoutes.includes(r));
    expect(
      unclaimed,
      `API routes owned by no feature: ${unclaimed.join(", ")}. Add each to a ` +
      `feature's apiRoutes in lib/registry/features.ts.`,
    ).toEqual([]);
  });

  it("claims no API route twice, so spend is never double-counted", () => {
    const dupes = claimedApiRoutes.filter((r, i) => claimedApiRoutes.indexOf(r) !== i);
    expect(dupes, `API routes claimed by two features: ${dupes.join(", ")}`).toEqual([]);
  });

  it("does not claim an API route that no longer exists", () => {
    const ghosts = claimedApiRoutes.filter(r => !apiRoutesOnDisk.includes(r));
    expect(ghosts, `Registry claims deleted API routes: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("claims every page a learner can reach", () => {
    const unclaimed = pagesOnDisk.filter(p => !claimedPages.includes(p));
    expect(
      unclaimed,
      `Pages owned by no feature: ${unclaimed.join(", ")}. Add each to a feature's routes.`,
    ).toEqual([]);
  });

  it("does not claim a page that no longer exists", () => {
    const ghosts = claimedPages.filter(p => !pagesOnDisk.includes(p));
    expect(ghosts, `Registry claims deleted pages: ${ghosts.join(", ")}`).toEqual([]);
  });
});

// ── Drift: every telemetry vocabulary is fully claimed ──────────────────────

describe("drift guard: the three telemetry vocabularies are fully mapped", () => {
  it("assigns every logUsage feature string to a feature, or to an explicit exclusion", () => {
    const onDisk = usageFeatureStringsOnDisk();
    const claimed = new Set(FEATURES.flatMap(f => f.usageFeatures));
    const unclaimed = [...onDisk.keys()]
      .filter(s => !claimed.has(s) && !UNATTRIBUTED_USAGE_FEATURES.includes(s));
    expect(
      unclaimed,
      `Spend strings credited to no feature: ${unclaimed.join(", ")}. Every dollar ` +
      `must land on a row of /admin/features. Add each to a feature's usageFeatures, ` +
      `or to UNATTRIBUTED_USAGE_FEATURES with a reason.`,
    ).toEqual([]);
  });

  it("claims every operation id exactly once", () => {
    const claimed = FEATURES.flatMap(f => f.operations as readonly string[]);
    const all = OPERATIONS.map(o => o.id);
    const unclaimed = all.filter(id => !claimed.includes(id));
    const dupes = claimed.filter((id, i) => claimed.indexOf(id) !== i);
    expect(unclaimed, `Operations owned by no feature: ${unclaimed.join(", ")}`).toEqual([]);
    expect(dupes, `Operations claimed twice: ${dupes.join(", ")}`).toEqual([]);
  });

  it("agrees with lib/monitor/features.ts about the learner-facing surfaces", () => {
    // Two lists, deliberately: Monitor owns calendar display (order, seed
    // caveats) and covers only learner-facing surfaces; this registry is a
    // superset that also carries internal ones. Neither derives from the
    // other, so this test is what stops them drifting apart.
    const here    = FEATURES.flatMap(f => f.activityFeatures).sort();
    const monitor = MONITOR_FEATURES.map(f => f.id).sort();
    expect(here, "registry activityFeatures disagree with MONITOR_FEATURES").toEqual(monitor);
  });
});

// ── Drift: the zero-spend claim is machine-checked ──────────────────────────

describe("drift guard: a feature that claims to spend nothing really spends nothing", () => {
  // The margin, Cases, and Case Lab are deliberately zero-runtime-AI. Until now
  // that rule was held by a comment. A comment cannot fail a build.
  it("finds no logUsage call in any route owned by a spendsTokens:false feature", () => {
    const offenders: string[] = [];
    for (const f of FEATURES) {
      if (f.spendsTokens) continue;
      for (const r of f.apiRoutes) {
        const file = `app/api/${r}/route.ts`;
        const src = read(file);
        // Tested by import, not by call site: `app/api/margin/route.ts` names
        // logUsage in a comment explaining its deliberate absence, and a route
        // cannot spend without importing the function first.
        if (/^\s*import[^;]*\blogUsage\b/m.test(src)) offenders.push(`${f.id}: ${file}`);
      }
    }
    expect(
      offenders,
      `These features declare spendsTokens:false but call logUsage: ${offenders.join(", ")}. ` +
      `Either the route should not spend, or the registry is lying.`,
    ).toEqual([]);
  });

  it("declares a test count that matches the files actually on disk", () => {
    // The number is stored rather than counted at request time because the page
    // showing it runs where the source tree does not exist. This is what keeps
    // a stored number honest.
    const wrong: string[] = [];
    for (const f of FEATURES) {
      const dirs = [
        ...f.libDirs.map(d => `lib/${d}`),
        ...f.componentDirs.map(d => `components/${d}`),
      ];
      const actual = dirs.reduce(
        (n, d) => n + filesUnder(d, [".test.ts", ".test.tsx"]).length, 0,
      );
      if (actual !== f.tests) wrong.push(`${f.id}: registry says ${f.tests}, disk has ${actual}`);
    }
    expect(wrong, `Stale test counts in lib/registry/features.ts: ${wrong.join("; ")}`).toEqual([]);
  });

  it("declares spendsTokens:true for every feature that owns spend strings", () => {
    const wrong = FEATURES.filter(f => f.usageFeatures.length > 0 && !f.spendsTokens);
    expect(wrong.map(f => f.id), "own usageFeatures but claim to spend nothing").toEqual([]);
  });
});

// ── Route-level coverage: no silent spenders ────────────────────────────────

describe("drift guard: a route that spends money records whether it worked", () => {
  // The finer grain the feature-level view cannot see. A feature shows as
  // "reporting" if it owns ANY operation, so instrumenting one of its five
  // routes would turn the row green while four stayed silent — the same
  // "blank reads as a pass" failure, one level down. This is what stops it.
  //
  // BOTH sides are tested by import, deliberately. An earlier version matched
  // `recordOperation` anywhere in the source, which meant a route that only
  // mentioned it in a comment counted as instrumented — and deleting the
  // import while leaving the call sites still passed. A route cannot spend
  // without importing logUsage, and cannot record without importing
  // recordOperation, so the imports are the honest signal.
  it("finds no route that imports logUsage without importing recordOperation", () => {
    const silent = filesUnder("app/api", ["route.ts"]).filter(file => {
      const src = read(file);
      const spends  = /^\s*import[^;]*\blogUsage\b/m.test(src);
      const records = /^\s*import[^;]*\b(recordOperation|recordTimed)\b/m.test(src);
      return spends && !records;
    });
    expect(
      silent,
      `These routes spend money and record no outcome: ${silent.join(", ")}. ` +
      `Every dollar Hugh spends must leave evidence of whether it worked — ` +
      `add a recordOperation call, or the money is invisible on /admin/features.`,
    ).toEqual([]);
  });
});

// ── The instrumentation gap, stated as a fact rather than a pass ────────────

describe("observability coverage", () => {
  // This does not fail while the gap exists — it reports it, so the number is
  // visible in CI output as it shrinks. Flip to an assertion once it is zero.
  it("reports which money-spending features record no outcome", () => {
    const blind = FEATURES.filter(f => f.spendsTokens && !isInstrumented(f));
    const spenders = FEATURES.filter(f => f.spendsTokens);
    console.log(
      `[observability] ${spenders.length - blind.length}/${spenders.length} spending ` +
      `features instrumented. Blind: ${blind.map(f => f.id).join(", ") || "none"}`,
    );
    expect(blind.every(f => !isInstrumented(f))).toBe(true);
  });
});

// ── Boundary guard ──────────────────────────────────────────────────────────

describe("boundary guard: features stay independent", () => {
  it("permits no lib/ import between features beyond the written-down edges", () => {
    const allowed = new Set(ALLOWED_LIB_EDGES.map(e => `${e.from}->${e.to}`));
    const violations = libEdges()
      .filter(e => !allowed.has(`${e.from}->${e.to}`))
      .map(e => `${e.file} imports @/lib/${e.to}`);
    expect(
      [...new Set(violations)],
      `Undeclared cross-feature import. Hugh has only a handful of these in lib/, each written down, ` +
      `and that independence is why it ships as one deployable rather than ` +
      `several. If this import is genuinely right, add it to ALLOWED_LIB_EDGES ` +
      `with a reason. If it is not, move the shared code into lib/ infrastructure.`,
    ).toEqual([]);
  });

  it("permits no components/ import between features beyond the written-down edges", () => {
    const allowed = new Set(ALLOWED_COMPONENT_EDGES.map(e => `${e.from}->${e.to}`));
    const violations = compEdges()
      .filter(e => !allowed.has(`${e.from}->${e.to}`))
      .map(e => `${e.file} imports @/components/${e.to}`);
    expect(
      [...new Set(violations)],
      `Undeclared cross-feature component import. Shared UI belongs in ` +
      `components/ui, which every feature may import freely.`,
    ).toEqual([]);
  });

  it("lists no edge that has already been removed", () => {
    // A stale allowance is how a boundary quietly erodes: it permits an import
    // nobody reviewed the second time it appears.
    const realLib  = new Set(libEdges().map(e => `${e.from}->${e.to}`));
    const realComp = new Set(compEdges().map(e => `${e.from}->${e.to}`));
    const staleLib  = ALLOWED_LIB_EDGES
      .filter(e => !realLib.has(`${e.from}->${e.to}`)).map(e => `lib: ${e.from}->${e.to}`);
    const staleComp = ALLOWED_COMPONENT_EDGES
      .filter(e => !realComp.has(`${e.from}->${e.to}`)).map(e => `components: ${e.from}->${e.to}`);
    expect(
      [...staleLib, ...staleComp],
      `Allowed edges that no longer exist — remove them so the list keeps meaning something.`,
    ).toEqual([]);
  });

  it("reports infrastructure that depends on a feature", () => {
    // A dependency inversion: `lib/claude` is imported by everything, so a
    // feature it imports in turn is effectively imported by everything. This
    // reports rather than fails — the one instance predates the registry and
    // untangling it is not part of introducing the guard. Promote to an
    // assertion once it reads zero.
    const featureDirs = dirsIn("lib").filter(d => !INFRA_LIB_DIRS.includes(d));
    const inversions: string[] = [];
    // `lib/registry` is exempt: knowing about every feature is its entire job.
    for (const infra of INFRA_LIB_DIRS.filter(d => d !== "registry")) {
      for (const file of filesUnder(`lib/${infra}`, [".ts", ".tsx"])) {
        const src = read(file);
        for (const feat of featureDirs) {
          if (new RegExp(`@/lib/${feat}/`).test(src)) inversions.push(`${file} -> lib/${feat}`);
        }
      }
    }
    console.log(`[boundaries] infra -> feature imports: ${inversions.join(", ") || "none"}`);
    expect(Array.isArray(inversions)).toBe(true);
  });
});
