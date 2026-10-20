// ── Reference packs — shared types ──────────────────────────────────────────
// A reference pack is the source-checked syllabus for one Learn topic: which
// concepts it covers, the order they build in, and what Hugh may say about
// each, every statement traced to a named source. See PRD-reference-packs.md.
//
// A pack stores our own wording plus a few anchor words per passage. It never
// stores the source's text — the anchor marks where the passage starts and
// ends, and the validator checks it is really there.

/**
 * A pack's lifecycle, in order. `provisional`: every anchor was found on its
 * live page. `machine-checked`: a blind judge found every key point fair to
 * its passage and caught every planted error. `approved`: a person's audit
 * also agreed. Hugh may use a pack from `machine-checked` up.
 */
export const PACK_STATUSES = ["draft", "provisional", "machine-checked", "approved"] as const;

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
  /**
   * Spec v1.2. A concept is never deleted, because a learner's card may still
   * point at it; it is retired instead, and taken off every card.
   */
  retired?: true;
}

/**
 * One card on the learner's board (spec v1.2): one to four concepts taught
 * together. A pack's cards, in order, ARE the track. No model chooses or
 * orders them; see PRD-narrow-learn.md, row 2.
 */
export interface PackCard {
  /** Permanent: a learner's board stores it. Lowercase letters, digits, - or _. */
  id:         string;
  title:      string;
  /** Concepts taught on this card, in the order they are taught. */
  conceptIds: string[];
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
  /**
   * An audit's verdict on the judge (spec v1.1). Absent on a v1 review, which
   * came before the machine check existed.
   */
  agreedWithJudge?: boolean;
}

/**
 * The record of a passed machine check (spec v1.1). Written only by
 * `npm run packs:check -- <id> --record-judgement`, never by hand.
 */
export interface PackMachineCheck {
  /** The model that judged, e.g. "claude-opus-5-5". */
  judgeModel: string;
  /** Which version of the judge's instructions it ran (lib/packs/judge.ts). */
  instructionsVersion: string;
  /** YYYY-MM-DD. */
  checkedAt: string;
  /** Real items: every key point plus every misconception's correction. */
  itemsJudged:    number;
  itemsSupported: number;
  /** Deliberately unfaithful items mixed in blind. */
  errorsPlanted:  number;
  errorsCaught:   number;
  /** What was judged. If the pack's key points change, this stops matching. */
  fingerprint: string;
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
  /** Spec v1.2. Required before a pack can be listed in the catalog. */
  cards?:        PackCard[];
  machineCheck?: PackMachineCheck;
  review?:       PackReview;
}
