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
import { COURSE_GROUPS, courseGroup, type CourseGroup, type CourseGroupId } from "./groups";
import descriptiveStatistics from "@/content/packs/descriptive-statistics.json";
import probabilityDistributions from "@/content/packs/probability-distributions.json";
import samplingAndSurveys from "@/content/packs/sampling-and-surveys.json";
import samplingDistributions from "@/content/packs/sampling-distributions.json";
import hypothesisTesting from "@/content/packs/hypothesis-testing.json";
import comparingGroups from "@/content/packs/comparing-groups.json";
import categoricalData from "@/content/packs/categorical-data.json";
import linearRegression from "@/content/packs/linear-regression.json";
import abTesting from "@/content/packs/ab-testing.json";
import timeSeriesForecasting from "@/content/packs/time-series-forecasting.json";
import clustering from "@/content/packs/clustering.json";
import decisionTrees from "@/content/packs/decision-trees.json";
import bayesianInference from "@/content/packs/bayesian-inference.json";
import outlierDetection from "@/content/packs/outlier-detection.json";
import neuralNetworks from "@/content/packs/neural-networks.json";
import classificationMetrics from "@/content/packs/classification-metrics.json";
import dimensionalityReduction from "@/content/packs/dimensionality-reduction.json";
import causalInference from "@/content/packs/causal-inference.json";

export interface CatalogEntry {
  id:    string;
  /** The picker group a course is shown in. Its learner-map region comes from the group. */
  group: CourseGroupId;
  raw:   unknown;
}

// Within a group, catalog order is the order the picker shows. The statistics
// foundations are a path: describe, then probability, then sampling, then
// inference, then comparing groups and categories.
const CATALOG: readonly CatalogEntry[] = [
  { id: "descriptive-statistics",    group: "stats-foundations", raw: descriptiveStatistics },
  { id: "probability-distributions", group: "stats-foundations", raw: probabilityDistributions },
  { id: "sampling-and-surveys",      group: "stats-foundations", raw: samplingAndSurveys },
  { id: "sampling-distributions",    group: "stats-foundations", raw: samplingDistributions },
  { id: "hypothesis-testing",        group: "stats-foundations", raw: hypothesisTesting },
  { id: "comparing-groups",          group: "stats-foundations", raw: comparingGroups },
  { id: "categorical-data",          group: "stats-foundations", raw: categoricalData },
  { id: "linear-regression",         group: "stats-modelling",   raw: linearRegression },
  { id: "bayesian-inference",        group: "stats-modelling",   raw: bayesianInference },
  { id: "time-series-forecasting",   group: "stats-modelling",   raw: timeSeriesForecasting },
  { id: "ab-testing",                group: "stats-in-practice", raw: abTesting },
  { id: "outlier-detection",         group: "stats-in-practice", raw: outlierDetection },
  { id: "causal-inference",          group: "stats-in-practice", raw: causalInference },
  { id: "classification-metrics",    group: "machine-learning",  raw: classificationMetrics },
  { id: "decision-trees",            group: "machine-learning",  raw: decisionTrees },
  { id: "neural-networks",           group: "machine-learning",  raw: neuralNetworks },
  { id: "clustering",                group: "machine-learning",  raw: clustering },
  { id: "dimensionality-reduction",  group: "machine-learning",  raw: dimensionalityReduction },
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
  return { ok: true, pack, region: courseGroup(entry.group).region };
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
  | { packId: string; group: CourseGroupId; course: CourseSummary; problem: null }
  | { packId: string; group: CourseGroupId; course: null;          problem: string };

export function catalogListing(entries: readonly CatalogEntry[] = CATALOG): CourseListing[] {
  return entries.map(e => {
    const result = entries === CATALOG ? loadPack(e.id) : loadEntry(e);
    return result.ok
      ? { packId: e.id, group: e.group, course: courseSummary(result.pack), problem: null }
      : { packId: e.id, group: e.group, course: null, problem: PACK_REFUSAL_MESSAGE[result.reason] };
  });
}

/** One group as the picker shows it: the group, then its courses in catalog order. */
export interface CatalogGroup {
  group:    CourseGroup;
  listings: CourseListing[];
}

/**
 * The listings arranged into groups, in the groups' display order. A group
 * with no courses yet is left out rather than shown empty. A broken course
 * still counts, because catalogListing lists it as broken.
 */
export function groupedCatalog(listings: readonly CourseListing[] = catalogListing()): CatalogGroup[] {
  return COURSE_GROUPS
    .map(group => ({ group, listings: listings.filter(l => l.group === group.id) }))
    .filter(g => g.listings.length > 0);
}

/** The catalog's ids, for tests and for the CI guard. */
export function catalogIds(): string[] {
  return CATALOG.map(e => e.id);
}
