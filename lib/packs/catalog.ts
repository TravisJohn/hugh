// ── The course catalog ──────────────────────────────────────────────────────
// Which reference packs learners may study, and the one place a pack is loaded
// for use. Packs are imported statically, so they are bundled with the server
// build rather than read from disk at runtime.
//
// A pack listed here must be machine-checked or better and carry its cards
// (spec v1.2). CI holds that for every entry (catalog.test.ts), and loadPack
// checks it again at runtime, so a pack that slips below the bar is refused
// with its own message instead of being taught (CLAUDE.md Rule 5).
//
// Pure: no I/O, no `server-only`.

import type { ReferencePack } from "@/types/pack";
import { checkPack, parsePack } from "./validate";
import linearRegression from "@/content/packs/linear-regression.json";
import abTesting from "@/content/packs/ab-testing.json";
import timeSeriesForecasting from "@/content/packs/time-series-forecasting.json";
import clustering from "@/content/packs/clustering.json";
import decisionTrees from "@/content/packs/decision-trees.json";
import bayesianInference from "@/content/packs/bayesian-inference.json";

export interface CatalogEntry {
  id:     string;
  /** The learner-map region a course is filed under (lib/learn/regions.ts). */
  region: string;
  raw:    unknown;
}

const CATALOG: readonly CatalogEntry[] = [
  { id: "linear-regression", region: "stats", raw: linearRegression },
  { id: "ab-testing",        region: "stats", raw: abTesting },
  { id: "time-series-forecasting", region: "stats", raw: timeSeriesForecasting },
  { id: "clustering",              region: "ml",    raw: clustering },
  { id: "decision-trees",          region: "ml",    raw: decisionTrees },
  { id: "bayesian-inference",      region: "stats", raw: bayesianInference },
];

/** The statuses Hugh may teach from. */
export const TEACHABLE_STATUSES: ReadonlySet<ReferencePack["status"]> = new Set(["machine-checked", "approved"]);

export type PackRefusal = "unknown" | "invalid" | "below-status" | "no-cards";

export type LoadedPack =
  | { ok: true;  pack: ReferencePack; region: string }
  | { ok: false; reason: PackRefusal };

/** Learner-facing copy for each refusal. Each says what happened, not "try again later". */
export const PACK_REFUSAL_MESSAGE: Record<PackRefusal, string> = {
  "unknown":      "That course isn't in Hugh's catalog.",
  "invalid":      "This course's syllabus failed its checks, so Hugh won't teach from it until it is fixed.",
  "below-status": "This course's syllabus hasn't passed its source check, so Hugh won't teach from it yet.",
  "no-cards":     "This course has no cards laid out yet, so there is no track to build.",
};

/** Every refusal is a fault in the catalog, not in the request, except an unknown id. */
export function refusalStatus(reason: PackRefusal): 404 | 503 {
  return reason === "unknown" ? 404 : 503;
}

/** Validate one entry from scratch. Exported for the catalog's own tests. */
export function loadEntry(entry: CatalogEntry): LoadedPack {
  const { pack, issues } = parsePack(entry.raw);
  if (!pack || issues.some(i => i.level === "error")) return { ok: false, reason: "invalid" };
  if (checkPack(pack).some(i => i.level === "error")) return { ok: false, reason: "invalid" };
  if (!TEACHABLE_STATUSES.has(pack.status)) return { ok: false, reason: "below-status" };
  if (!pack.cards || pack.cards.length === 0) return { ok: false, reason: "no-cards" };
  return { ok: true, pack, region: entry.region };
}

// Validated once per server instance. The packs are bundled, so they cannot
// change underneath a running process.
const loaded = new Map<string, LoadedPack>();

export function loadPack(id: string): LoadedPack {
  const cached = loaded.get(id);
  if (cached) return cached;
  const entry = CATALOG.find(e => e.id === id);
  const result: LoadedPack = entry ? loadEntry(entry) : { ok: false, reason: "unknown" };
  if (entry) loaded.set(id, result);
  return result;
}

/** What the course picker shows for one course. Plain data, safe to send to the browser. */
export interface CourseSummary {
  packId:     string;
  version:    string;
  subject:    string;
  cardCount:  number;
  /** Who the sources are from, each named once, in the pack's order. */
  publishers: string[];
}

export function courseSummary(pack: ReferencePack): CourseSummary {
  return {
    packId:     pack.id,
    version:    pack.version,
    subject:    pack.subject,
    cardCount:  pack.cards?.length ?? 0,
    publishers: [...new Set(pack.sources.map(s => s.publisher))],
  };
}

/**
 * One catalog entry as the picker shows it: a course to start, or the reason
 * it can't be started. A broken pack is listed AS broken, never dropped, so an
 * empty picker can only mean an empty catalog (CLAUDE.md Rule 5).
 */
export type CourseListing =
  | { packId: string; course: CourseSummary; problem: null }
  | { packId: string; course: null;          problem: string };

export function catalogListing(entries: readonly CatalogEntry[] = CATALOG): CourseListing[] {
  return entries.map(e => {
    const result = entries === CATALOG ? loadPack(e.id) : loadEntry(e);
    return result.ok
      ? { packId: e.id, course: courseSummary(result.pack), problem: null }
      : { packId: e.id, course: null, problem: PACK_REFUSAL_MESSAGE[result.reason] };
  });
}

/** The catalog's ids, for tests and for the CI guard. */
export function catalogIds(): string[] {
  return CATALOG.map(e => e.id);
}
