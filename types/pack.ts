// ── Reference packs — shared types ──────────────────────────────────────────
// A reference pack is the source-checked syllabus for one Learn topic: which
// concepts it covers, the order they build in, and what Hugh may say about
// each, every statement traced to a named source. See PRD-reference-packs.md.
//
// A pack stores our own wording plus a few anchor words per passage. It never
// stores the source's text — the anchor marks where the passage starts and
// ends, and the validator checks it is really there.

/**
 * A pack's lifecycle. `provisional` means the validator passed; `approved`
 * means a person has also spot-checked a sample against the sources.
 */
export const PACK_STATUSES = ["draft", "provisional", "approved"] as const;

export type PackStatus = (typeof PACK_STATUSES)[number];

export function isPackStatus(v: unknown): v is PackStatus {
  return typeof v === "string" && (PACK_STATUSES as readonly string[]).includes(v);
}

export interface PackSource {
  id:        string;
  title:     string;
  publisher: string;
  url:       string;
  /** Only when the publisher states one, e.g. "CC BY-NC 4.0". */
  license?:  string;
  /** The date the page was read, YYYY-MM-DD. Pages change; this says when. */
  accessedAt: string;
}

/** A few words copied exactly from the source, at each end of the passage. */
export interface PackAnchor {
  start: string;
  end:   string;
}

export interface PackKeyPoint {
  /** Our own words. Never the source's sentence. */
  text:     string;
  sourceId: string;
  /** Where in the source: a lesson or section, or a page number for a PDF. */
  locator:  string;
  anchor:   PackAnchor;
}

export interface PackMisconception {
  /** The wrong belief, stated the way a learner might hold it. */
  claim:      string;
  correction: string;
  sourceId:   string;
  locator:    string;
  anchor:     PackAnchor;
}

export interface PackConcept {
  id:      string;
  title:   string;
  /** What the learner can do once they have it. */
  outcome: string;
  keyPoints:       PackKeyPoint[];
  misconceptions?: PackMisconception[];
  aliases?:        string[];
}

export interface PackPrerequisite {
  before: string;
  after:  string;
  reason: string;
}

export interface PackReview {
  reviewedBy: string;
  /** YYYY-MM-DD. */
  reviewedAt: string;
  /** Key points the reviewer checked, as `conceptId:n` (n counts from 1). */
  sampledKeyPoints: string[];
}

export interface ReferencePack {
  id:      string;
  /** Semver. A changed concept or key point is a new version. */
  version: string;
  status:  PackStatus;
  subject: string;
  outOfScope:    string[];
  sources:       PackSource[];
  concepts:      PackConcept[];
  prerequisites: PackPrerequisite[];
  review?:       PackReview;
}
