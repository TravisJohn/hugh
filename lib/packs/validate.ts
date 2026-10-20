// ── Reference packs: the validator's rules ──────────────────────────────────
// Everything that can be checked without the network: the file's shape, that
// every reference resolves, the size limits, that a learning order exists, and
// that an "approved" pack carries its reviewer's sample. Anchors are checked
// against fetched pages by scripts/validate-pack.ts, using ./anchor.
//
// Pure: no I/O, no `server-only`. See PRD-reference-packs.md for the rules.

import {
  isPackStatus,
  type PackAnchor, type PackCard, type PackConcept, type PackKeyPoint, type PackMachineCheck, type PackMisconception,
  type PackPrerequisite, type PackReview, type PackSource, type ReferencePack,
} from "@/types/pack";
import { wordCount } from "./anchor";
import { errorsRequired, fingerprint, judgedItems } from "./judge";

export const KEY_POINTS_MIN     = 2;
export const KEY_POINTS_MAX     = 5;
export const MISCONCEPTIONS_MAX = 3;
export const KEY_POINT_MAX_WORDS = 40;
export const ANCHOR_MIN_WORDS   = 2;
export const ANCHOR_MAX_WORDS   = 6;
export const REVIEW_MIN_SAMPLE  = 5;
// Spec v1.2: a board of 8-14 cards fits the no-scroll track board, and 1-4
// concepts keeps one card one sitting.
export const CARDS_MIN          = 8;
export const CARDS_MAX          = 14;
export const CARD_CONCEPTS_MIN  = 1;
export const CARD_CONCEPTS_MAX  = 4;

export interface PackIssue {
  level:   "error" | "warning";
  /** Where in the file, e.g. `concepts[3].keyPoints[1].anchor.start`. */
  path:    string;
  message: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Shape ───────────────────────────────────────────────────────────────────
// Each reader records an error and returns null rather than throwing, so one
// run reports every problem in the file instead of the first.

class ShapeReader {
  readonly issues: PackIssue[] = [];

  fail(path: string, message: string): null {
    this.issues.push({ level: "error", path, message });
    return null;
  }

  str(o: Obj, key: string, path: string): string | null {
    const v = o[key];
    return typeof v === "string" && v.trim() !== ""
      ? v
      : this.fail(`${path}.${key}`, "must be a non-empty string");
  }

  optStr(o: Obj, key: string, path: string): string | undefined | null {
    return o[key] === undefined ? undefined : this.str(o, key, path);
  }

  list<T>(o: Obj, key: string, path: string, item: (v: unknown, p: string) => T | null): T[] | null {
    const v = o[key];
    if (!Array.isArray(v)) return this.fail(`${path}.${key}`, "must be an array");
    const out = v.map((entry, i) => item(entry, `${path}.${key}[${i}]`));
    return out.every((x): x is T => x !== null) ? out : null;
  }

  optList<T>(o: Obj, key: string, path: string, item: (v: unknown, p: string) => T | null): T[] | undefined | null {
    return o[key] === undefined ? undefined : this.list(o, key, path, item);
  }

  string = (v: unknown, p: string): string | null =>
    typeof v === "string" && v.trim() !== "" ? v : this.fail(p, "must be a non-empty string");

  anchor = (v: unknown, p: string): PackAnchor | null => {
    if (!isObj(v)) return this.fail(p, "must be an object with start and end");
    const start = this.str(v, "start", p);
    const end   = this.str(v, "end", p);
    return start !== null && end !== null ? { start, end } : null;
  };

  source = (v: unknown, p: string): PackSource | null => {
    if (!isObj(v)) return this.fail(p, "must be an object");
    const id = this.str(v, "id", p), title = this.str(v, "title", p);
    const publisher = this.str(v, "publisher", p), url = this.str(v, "url", p);
    const accessedAt = this.str(v, "accessedAt", p), license = this.optStr(v, "license", p);
    if (id === null || title === null || publisher === null || url === null || accessedAt === null || license === null) return null;
    return { id, title, publisher, url, accessedAt, ...(license !== undefined ? { license } : {}) };
  };

  keyPoint = (v: unknown, p: string): PackKeyPoint | null => {
    if (!isObj(v)) return this.fail(p, "must be an object");
    const text = this.str(v, "text", p), sourceId = this.str(v, "sourceId", p);
    const locator = this.str(v, "locator", p), anchor = this.anchor(v.anchor, `${p}.anchor`);
    return text !== null && sourceId !== null && locator !== null && anchor !== null
      ? { text, sourceId, locator, anchor } : null;
  };

  misconception = (v: unknown, p: string): PackMisconception | null => {
    if (!isObj(v)) return this.fail(p, "must be an object");
    const claim = this.str(v, "claim", p), correction = this.str(v, "correction", p);
    const sourceId = this.str(v, "sourceId", p), locator = this.str(v, "locator", p);
    const anchor = this.anchor(v.anchor, `${p}.anchor`);
    return claim !== null && correction !== null && sourceId !== null && locator !== null && anchor !== null
      ? { claim, correction, sourceId, locator, anchor } : null;
  };

  concept = (v: unknown, p: string): PackConcept | null => {
    if (!isObj(v)) return this.fail(p, "must be an object");
    const id = this.str(v, "id", p), title = this.str(v, "title", p), outcome = this.str(v, "outcome", p);
    const keyPoints = this.list(v, "keyPoints", p, this.keyPoint);
    const misconceptions = this.optList(v, "misconceptions", p, this.misconception);
    const aliases = this.optList(v, "aliases", p, this.string);
    const retired = v.retired === undefined || v.retired === true ? v.retired : this.fail(`${p}.retired`, "is either true or left out");
    if (id === null || title === null || outcome === null || keyPoints === null || misconceptions === null || aliases === null || retired === null) return null;
    return {
      id, title, outcome, keyPoints,
      ...(misconceptions !== undefined ? { misconceptions } : {}),
      ...(aliases !== undefined ? { aliases } : {}),
      ...(retired === true ? { retired } : {}),
    };
  };

  card = (v: unknown, p: string): PackCard | null => {
    if (!isObj(v)) return this.fail(p, "must be an object");
    const id = this.str(v, "id", p), title = this.str(v, "title", p);
    const conceptIds = this.list(v, "conceptIds", p, this.string);
    return id !== null && title !== null && conceptIds !== null ? { id, title, conceptIds } : null;
  };

  prerequisite = (v: unknown, p: string): PackPrerequisite | null => {
    if (!isObj(v)) return this.fail(p, "must be an object");
    const before = this.str(v, "before", p), after = this.str(v, "after", p), reason = this.str(v, "reason", p);
    return before !== null && after !== null && reason !== null ? { before, after, reason } : null;
  };

  review = (v: unknown, p: string): PackReview | null => {
    if (!isObj(v)) return this.fail(p, "must be an object");
    const reviewedBy = this.str(v, "reviewedBy", p), reviewedAt = this.str(v, "reviewedAt", p);
    const sampledKeyPoints = this.list(v, "sampledKeyPoints", p, this.string);
    if (v.agreedWithJudge !== undefined && typeof v.agreedWithJudge !== "boolean") {
      return this.fail(`${p}.agreedWithJudge`, "must be true or false");
    }
    return reviewedBy !== null && reviewedAt !== null && sampledKeyPoints !== null
      ? { reviewedBy, reviewedAt, sampledKeyPoints, ...(typeof v.agreedWithJudge === "boolean" ? { agreedWithJudge: v.agreedWithJudge } : {}) }
      : null;
  };

  count(o: Obj, key: string, path: string): number | null {
    const v = o[key];
    return typeof v === "number" && Number.isInteger(v) && v >= 0
      ? v
      : this.fail(`${path}.${key}`, "must be a whole number, 0 or more");
  }

  machineCheck = (v: unknown, p: string): PackMachineCheck | null => {
    if (!isObj(v)) return this.fail(p, "must be an object");
    const judgeModel = this.str(v, "judgeModel", p), instructionsVersion = this.str(v, "instructionsVersion", p);
    const checkedAt = this.str(v, "checkedAt", p), fingerprint = this.str(v, "fingerprint", p);
    const itemsJudged = this.count(v, "itemsJudged", p), itemsSupported = this.count(v, "itemsSupported", p);
    const errorsPlanted = this.count(v, "errorsPlanted", p), errorsCaught = this.count(v, "errorsCaught", p);
    if (judgeModel === null || instructionsVersion === null || checkedAt === null || fingerprint === null ||
        itemsJudged === null || itemsSupported === null || errorsPlanted === null || errorsCaught === null) return null;
    return { judgeModel, instructionsVersion, checkedAt, itemsJudged, itemsSupported, errorsPlanted, errorsCaught, fingerprint };
  };
}

/**
 * Read an untrusted JSON value as a pack. Returns the pack only when its shape
 * is complete; `issues` lists every shape problem found, not just the first.
 */
export function parsePack(raw: unknown): { pack: ReferencePack | null; issues: PackIssue[] } {
  const r = new ShapeReader();
  if (!isObj(raw)) return { pack: null, issues: [{ level: "error", path: "$", message: "a pack must be a JSON object" }] };

  const id = r.str(raw, "id", "$"), version = r.str(raw, "version", "$"), subject = r.str(raw, "subject", "$");
  const status = isPackStatus(raw.status) ? raw.status : r.fail("$.status", "must be draft, provisional, machine-checked or approved");
  const outOfScope    = r.list(raw, "outOfScope", "$", r.string);
  const sources       = r.list(raw, "sources", "$", r.source);
  const concepts      = r.list(raw, "concepts", "$", r.concept);
  const prerequisites = r.list(raw, "prerequisites", "$", r.prerequisite);
  const cards         = r.optList(raw, "cards", "$", r.card);
  const machineCheck = raw.machineCheck === undefined ? undefined : r.machineCheck(raw.machineCheck, "$.machineCheck");
  const review = raw.review === undefined ? undefined : r.review(raw.review, "$.review");

  if (id === null || version === null || subject === null || status === null || outOfScope === null ||
      sources === null || concepts === null || prerequisites === null || cards === null || machineCheck === null || review === null) {
    return { pack: null, issues: r.issues };
  }
  return {
    pack: {
      id, version, status, subject, outOfScope, sources, concepts, prerequisites,
      ...(cards !== undefined ? { cards } : {}),
      ...(machineCheck !== undefined ? { machineCheck } : {}),
      ...(review !== undefined ? { review } : {}),
    },
    issues: r.issues,
  };
}

// ── Learning order ──────────────────────────────────────────────────────────

export type LearningOrder = { ok: true; order: string[] } | { ok: false; cycle: string[] };

/**
 * A valid order to learn the concepts in, honouring every prerequisite and
 * otherwise keeping the pack's own order (Kahn's algorithm, ties broken by
 * position). If the prerequisites loop, no order exists; `cycle` lists the
 * concepts caught in it so the author can see which edge to cut.
 */
export function learningOrder(conceptIds: readonly string[], prerequisites: readonly PackPrerequisite[]): LearningOrder {
  const position = new Map(conceptIds.map((id, i) => [id, i]));
  const indegree = new Map(conceptIds.map(id => [id, 0]));
  const next = new Map<string, string[]>(conceptIds.map(id => [id, []]));
  for (const { before, after } of prerequisites) {
    if (!position.has(before) || !position.has(after)) continue; // reported by checkPack
    next.get(before)!.push(after);
    indegree.set(after, indegree.get(after)! + 1);
  }

  const ready = conceptIds.filter(id => indegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const id = ready.shift()!;
    order.push(id);
    for (const after of next.get(id)!) {
      indegree.set(after, indegree.get(after)! - 1);
      if (indegree.get(after) === 0) ready.push(after);
    }
  }
  return order.length === conceptIds.length
    ? { ok: true, order }
    : { ok: false, cycle: conceptIds.filter(id => !order.includes(id)) };
}

// ── Everything the anchors point at ─────────────────────────────────────────

export interface AnchorTarget {
  /** `conceptId:n` for key points, `conceptId:mn` for misconceptions; n from 1. */
  ref:      string;
  path:     string;
  sourceId: string;
  locator:  string;
  anchor:   PackAnchor;
}

export function anchorTargets(pack: ReferencePack): AnchorTarget[] {
  return pack.concepts.flatMap((c, ci) => [
    ...c.keyPoints.map((k, i) => ({
      ref: `${c.id}:${i + 1}`, path: `concepts[${ci}].keyPoints[${i}]`,
      sourceId: k.sourceId, locator: k.locator, anchor: k.anchor,
    })),
    ...(c.misconceptions ?? []).map((m, i) => ({
      ref: `${c.id}:m${i + 1}`, path: `concepts[${ci}].misconceptions[${i}]`,
      sourceId: m.sourceId, locator: m.locator, anchor: m.anchor,
    })),
  ]);
}

/** Every key point's `conceptId:n` ref, the unit a reviewer samples. */
export function keyPointRefs(pack: ReferencePack): string[] {
  return pack.concepts.flatMap(c => c.keyPoints.map((_, i) => `${c.id}:${i + 1}`));
}

/**
 * Pick `n` distinct key points for a spot-check. `random` is injected so a
 * test can pin the draw; the script passes Math.random.
 */
export function sampleKeyPoints(pack: ReferencePack, n: number, random: () => number): string[] {
  const pool = keyPointRefs(pack);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

// ── Meaning ─────────────────────────────────────────────────────────────────

const ID      = /^[a-z0-9][a-z0-9_-]*$/;
const SEMVER  = /^\d+\.\d+\.\d+$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isDay(s: string): boolean {
  return ISO_DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
}

function isHttpsUrl(s: string): boolean {
  try { return new URL(s).protocol === "https:"; } catch { return false; }
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>(), dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/**
 * Spec v1.2: the cards are the track, so they must cover the syllabus exactly
 * and never teach a concept before something it depends on. A prerequisite
 * may sit on the same card as its dependant: the card teaches them in order.
 */
function checkCards(pack: ReferencePack, cards: readonly PackCard[], error: (path: string, message: string) => void): void {
  if (cards.length < CARDS_MIN || cards.length > CARDS_MAX) {
    error("$.cards", `needs ${CARDS_MIN}-${CARDS_MAX} cards, has ${cards.length}`);
  }
  for (const id of duplicates(cards.map(c => c.id))) error("$.cards", `duplicate card id "${id}"`);

  const concepts = new Map(pack.concepts.map(c => [c.id, c]));
  const cardOf   = new Map<string, number>();

  cards.forEach((card, ci) => {
    const p = `cards[${ci}]`;
    if (!ID.test(card.id)) error(`${p}.id`, "must be lowercase letters, digits, - or _");
    if (card.conceptIds.length < CARD_CONCEPTS_MIN || card.conceptIds.length > CARD_CONCEPTS_MAX) {
      error(`${p}.conceptIds`, `needs ${CARD_CONCEPTS_MIN}-${CARD_CONCEPTS_MAX} concepts, has ${card.conceptIds.length}`);
    }
    for (const id of card.conceptIds) {
      const concept = concepts.get(id);
      if (!concept)        { error(`${p}.conceptIds`, `"${id}" is not a concept`); continue; }
      if (concept.retired) error(`${p}.conceptIds`, `"${id}" is retired and cannot be taught`);
      if (cardOf.has(id))  error(`${p}.conceptIds`, `"${id}" is already on cards[${cardOf.get(id)}]`);
      else cardOf.set(id, ci);
    }
  });

  for (const c of pack.concepts) {
    if (!c.retired && !cardOf.has(c.id)) error("$.cards", `concept "${c.id}" is on no card`);
  }

  for (const e of pack.prerequisites) {
    const before = cardOf.get(e.before), after = cardOf.get(e.after);
    if (before !== undefined && after !== undefined && before > after) {
      error("$.cards", `"${e.before}" (cards[${before}]) must come before "${e.after}" (cards[${after}])`);
    }
  }
}

/**
 * Check a parsed pack against the spec's offline rules. Errors block the pack
 * from leaving draft; warnings are worth a look but do not.
 */
export function checkPack(pack: ReferencePack): PackIssue[] {
  const issues: PackIssue[] = [];
  const error   = (path: string, message: string) => issues.push({ level: "error", path, message });
  const warning = (path: string, message: string) => issues.push({ level: "warning", path, message });

  if (!ID.test(pack.id)) error("$.id", "must be lowercase letters, digits, - or _");
  if (!SEMVER.test(pack.version)) error("$.version", "must be semver, e.g. 1.0.0");

  const sourceIds  = pack.sources.map(s => s.id);
  const conceptIds = pack.concepts.map(c => c.id);
  for (const id of duplicates(sourceIds))  error("$.sources", `duplicate source id "${id}"`);
  for (const id of duplicates(conceptIds)) error("$.concepts", `duplicate concept id "${id}"`);
  if (pack.concepts.length === 0) error("$.concepts", "a pack needs at least one concept");

  pack.sources.forEach((s, i) => {
    const p = `sources[${i}]`;
    if (!ID.test(s.id)) error(`${p}.id`, "must be lowercase letters, digits, - or _");
    if (!isHttpsUrl(s.url)) error(`${p}.url`, "must be an https URL");
    if (!isDay(s.accessedAt)) error(`${p}.accessedAt`, "must be a real date, YYYY-MM-DD");
  });

  const knownSources = new Set(sourceIds);
  const usedSources  = new Set<string>();

  pack.concepts.forEach((c, ci) => {
    const p = `concepts[${ci}]`;
    if (!ID.test(c.id)) error(`${p}.id`, "must be lowercase letters, digits, - or _");
    if (c.keyPoints.length < KEY_POINTS_MIN || c.keyPoints.length > KEY_POINTS_MAX) {
      error(`${p}.keyPoints`, `needs ${KEY_POINTS_MIN}-${KEY_POINTS_MAX} key points, has ${c.keyPoints.length}`);
    }
    if ((c.misconceptions?.length ?? 0) > MISCONCEPTIONS_MAX) {
      error(`${p}.misconceptions`, `allows at most ${MISCONCEPTIONS_MAX}`);
    }
    c.keyPoints.forEach((k, i) => {
      const words = wordCount(k.text);
      if (words > KEY_POINT_MAX_WORDS) error(`${p}.keyPoints[${i}].text`, `is ${words} words; the limit is ${KEY_POINT_MAX_WORDS}`);
    });
  });

  for (const t of anchorTargets(pack)) {
    usedSources.add(t.sourceId);
    if (!knownSources.has(t.sourceId)) error(`${t.path}.sourceId`, `"${t.sourceId}" is not in sources`);
    for (const side of ["start", "end"] as const) {
      const words = wordCount(t.anchor[side]);
      if (words < ANCHOR_MIN_WORDS || words > ANCHOR_MAX_WORDS) {
        error(`${t.path}.anchor.${side}`, `is ${words} words; anchors take ${ANCHOR_MIN_WORDS}-${ANCHOR_MAX_WORDS}`);
      }
    }
  }
  pack.sources.forEach((s, i) => {
    if (!usedSources.has(s.id)) warning(`sources[${i}]`, `"${s.id}" is never cited`);
  });

  const knownConcepts = new Set(conceptIds);
  const edges = new Set<string>();
  pack.prerequisites.forEach((e, i) => {
    const p = `prerequisites[${i}]`;
    if (!knownConcepts.has(e.before)) error(`${p}.before`, `"${e.before}" is not a concept`);
    if (!knownConcepts.has(e.after))  error(`${p}.after`, `"${e.after}" is not a concept`);
    if (e.before === e.after) error(p, "a concept cannot be its own prerequisite");
    const key = `${e.before}>${e.after}`;
    if (edges.has(key)) warning(p, `repeats ${e.before} -> ${e.after}`);
    edges.add(key);
  });
  const order = learningOrder(conceptIds, pack.prerequisites);
  if (!order.ok) error("$.prerequisites", `form a loop through: ${order.cycle.join(", ")}`);

  if (pack.cards) checkCards(pack, pack.cards, error);

  // Spec v1.1: from machine-checked up, a pack must carry a passed machine
  // check that still matches what it says. An edit after the check makes the
  // fingerprint stop matching, and the pack must go back to provisional.
  if (pack.status === "machine-checked" || pack.status === "approved") {
    const mc = pack.machineCheck;
    if (!mc) {
      error("$.machineCheck", `a ${pack.status} pack must record a passed machine check`);
    } else {
      if (mc.fingerprint !== fingerprint(pack)) {
        error("$.machineCheck.fingerprint", "key points or misconceptions changed after the machine check; set status to provisional and judge again");
      }
      const real = judgedItems(pack).length;
      if (mc.itemsJudged !== real) error("$.machineCheck.itemsJudged", `says ${mc.itemsJudged} items; the pack has ${real}`);
      if (mc.itemsSupported !== mc.itemsJudged) error("$.machineCheck.itemsSupported", "every judged item must be supported");
      if (mc.errorsCaught !== mc.errorsPlanted) error("$.machineCheck.errorsCaught", "every planted error must be caught");
      if (mc.errorsPlanted < errorsRequired(mc.itemsJudged)) {
        error("$.machineCheck.errorsPlanted", `needs at least ${errorsRequired(mc.itemsJudged)} planted errors`);
      }
      if (!isDay(mc.checkedAt)) error("$.machineCheck.checkedAt", "must be a real date, YYYY-MM-DD");
    }
  } else if (pack.machineCheck) {
    warning("$.machineCheck", `recorded on a ${pack.status} pack; judge again before raising its status`);
  }

  if (pack.status === "approved") {
    if (!pack.review) {
      error("$.review", "an approved pack must record its spot-check");
    } else {
      const refs = new Set(keyPointRefs(pack));
      const sample = pack.review.sampledKeyPoints;
      if (!isDay(pack.review.reviewedAt)) error("$.review.reviewedAt", "must be a real date, YYYY-MM-DD");
      if (new Set(sample).size < REVIEW_MIN_SAMPLE) {
        error("$.review.sampledKeyPoints", `needs at least ${REVIEW_MIN_SAMPLE} distinct key points`);
      }
      for (const ref of sample) if (!refs.has(ref)) error("$.review.sampledKeyPoints", `"${ref}" is not a key point`);
    }
  } else if (pack.review) {
    warning("$.review", `recorded on a ${pack.status} pack; it only counts once status is approved`);
  }

  return issues;
}
