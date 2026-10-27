// ── What a card's pack says ─────────────────────────────────────────────────
// The ONE place Ask, mastery, the diary check, the review quiz and the card's
// Sources list read a reference pack from (PRD-narrow-learn.md, PR B). Each of
// those takes what it needs from here as plain data or as the rendered
// syllabus block, so none of them imports a pack itself.
//
// A card is grounded by `milestones.concept_ids` (migration 060), which a
// learner's own session cannot write. Never by `learning_goals.pack_id`, which
// it can.
//
// Pure: no I/O, no `server-only`.

import type { PackAnchor, PackSource, ReferencePack } from "@/types/pack";
import { loadPack, PACK_REFUSAL_MESSAGE, type PackRefusal } from "./catalog";
import { parseQualifiedConceptId } from "./track";
import { textFragmentUrl } from "./anchor";
import { CHOOSE_COURSE_HREF, EARLIER_TOPIC_READ_ONLY } from "@/lib/learn/earlierTopic";

/** Where a statement comes from, ready to show: a link that opens the passage when the page allows it. */
export interface CardSource {
  publisher: string;
  title:     string;
  locator:   string;
  /** Opens the source scrolled to the passage and highlighted; a PDF links plainly. */
  href:      string;
  /** True when the link cannot highlight (a PDF): the reader uses `locator`. */
  manual:    boolean;
}

export interface GroundedKeyPoint {
  /** `conceptId:n`, the reference the machine check and the checklist use. */
  ref:    string;
  text:   string;
  source: CardSource;
}

export interface GroundedMisconception {
  /** `conceptId:mn`. */
  ref:        string;
  claim:      string;
  correction: string;
  source:     CardSource;
}

export interface GroundedConcept {
  id:             string;
  title:          string;
  outcome:        string;
  keyPoints:      GroundedKeyPoint[];
  misconceptions: GroundedMisconception[];
}

export interface CardGround {
  packId:     string;
  version:    string;
  subject:    string;
  outOfScope: string[];
  /** The card's own concepts, in teaching order. */
  concepts:   GroundedConcept[];
  /** Every other card, by title, with the concepts it teaches: where to point a learner. */
  otherCards: Array<{ title: string; concepts: string[] }>;
}

/**
 * Why a card can't be taught from a syllabus. `earlier-topic` is a card with
 * no concept ids: one built from a typed topic or a document before the
 * catalog. Since narrow Learn PR D it is read-only, which is this one switch
 * rather than a check copied into each route (PRD phase 2, module 6).
 */
export type GroundingRefusal = PackRefusal | "mixed-packs" | "unknown-concept" | "earlier-topic";

export type CardGrounding =
  | { kind: "ok"; ground: CardGround }
  /** An earlier topic, or a course card whose pack cannot be taught from. */
  | { kind: "refused"; reason: GroundingRefusal };

export const GROUNDING_REFUSAL_MESSAGE: Record<GroundingRefusal, string> = {
  ...PACK_REFUSAL_MESSAGE,
  "mixed-packs":     "This card names concepts from more than one course, so Hugh can't tell which syllabus to teach from.",
  "unknown-concept": "This card names a concept its course no longer has, so Hugh can't teach it from the syllabus.",
  "earlier-topic":   EARLIER_TOPIC_READ_ONLY,
};

/**
 * The status and body every route sends for a refused card. An earlier topic
 * is refused on purpose and for good, so it is a 409 with the way out to the
 * catalog (Rule 5). A course card whose pack can't be loaded is the server's
 * problem, so it stays a 503.
 */
export function groundingRefusal(reason: GroundingRefusal): {
  status: number;
  body:   { error: string; chooseCourse?: string };
} {
  const error = GROUNDING_REFUSAL_MESSAGE[reason];
  return reason === "earlier-topic"
    ? { status: 409, body: { error, chooseCourse: CHOOSE_COURSE_HREF } }
    : { status: 503, body: { error } };
}

function isPdfUrl(url: string): boolean {
  return /\.pdf$/i.test(url.split(/[?#]/)[0] ?? "");
}

function cardSource(source: PackSource | undefined, locator: string, anchor: PackAnchor): CardSource {
  // A source the pack cites always exists (the validator checks it); this only
  // keeps the type honest if that ever breaks.
  if (!source) return { publisher: "Unknown source", title: "", locator, href: "", manual: true };
  const manual = isPdfUrl(source.url);
  return {
    publisher: source.publisher,
    title:     source.title,
    locator,
    href:      manual ? source.url : textFragmentUrl(source.url, anchor),
    manual,
  };
}

/** Ground one card from its stored concept ids. */
export function cardGrounding(conceptIds: readonly string[] | null | undefined): CardGrounding {
  if (!conceptIds || conceptIds.length === 0) return { kind: "refused", reason: "earlier-topic" };

  const parsed = conceptIds.map(parseQualifiedConceptId);
  if (parsed.some(p => p === null)) return { kind: "refused", reason: "unknown-concept" };
  const packIds = new Set(parsed.map(p => p!.packId));
  if (packIds.size !== 1) return { kind: "refused", reason: "mixed-packs" };

  const loaded = loadPack([...packIds][0]!);
  if (!loaded.ok) return { kind: "refused", reason: loaded.reason };
  return groundFromPack(loaded.pack, parsed.map(p => p!.conceptId));
}

/** The pack half of `cardGrounding`, given an already-loaded pack. Exported for tests. */
export function groundFromPack(pack: ReferencePack, conceptIds: readonly string[]): CardGrounding {
  const byId    = new Map(pack.concepts.map(c => [c.id, c]));
  const sources = new Map(pack.sources.map(s => [s.id, s]));

  const concepts: GroundedConcept[] = [];
  for (const id of conceptIds) {
    const c = byId.get(id);
    if (!c) return { kind: "refused", reason: "unknown-concept" };
    concepts.push({
      id: c.id, title: c.title, outcome: c.outcome,
      keyPoints: c.keyPoints.map((k, i) => ({
        ref: `${c.id}:${i + 1}`, text: k.text, source: cardSource(sources.get(k.sourceId), k.locator, k.anchor),
      })),
      misconceptions: (c.misconceptions ?? []).map((m, i) => ({
        ref: `${c.id}:m${i + 1}`, claim: m.claim, correction: m.correction,
        source: cardSource(sources.get(m.sourceId), m.locator, m.anchor),
      })),
    });
  }

  const own = new Set(conceptIds);
  const otherCards = (pack.cards ?? [])
    .filter(card => !card.conceptIds.some(id => own.has(id)))
    .map(card => ({ title: card.title, concepts: card.conceptIds.map(id => byId.get(id)?.title ?? id) }));

  return {
    kind: "ok",
    ground: { packId: pack.id, version: pack.version, subject: pack.subject, outOfScope: pack.outOfScope, concepts, otherCards },
  };
}

/**
 * The card's syllabus as a prompt block. Every model-facing surface uses this
 * same rendering, so Ask, the diary check, the quiz and mastery are judged
 * against identical text. Stable for a card, so it sits in a cacheable prefix.
 */
export function renderCardSyllabus(g: CardGround): string {
  const concepts = g.concepts.map(c => [
    `### ${c.title}`,
    `Outcome: ${c.outcome}`,
    `Key points:`,
    ...c.keyPoints.map(k => `- [${k.ref}] ${k.text}`),
    ...(c.misconceptions.length
      ? [`Common misconceptions:`, ...c.misconceptions.map(m => `- [${m.ref}] Wrong belief: ${m.claim}\n  Correction: ${m.correction}`)]
      : []),
  ].join("\n"));

  return [
    `<course_syllabus>`,
    `Course: ${g.subject}`,
    `This course does not cover: ${g.outOfScope.join("; ") || "nothing listed"}.`,
    ``,
    `Other cards in this course:`,
    ...(g.otherCards.length ? g.otherCards.map(c => `- "${c.title}": ${c.concepts.join(", ")}`) : ["- (none)"]),
    ``,
    `This card's concepts (source-checked; the authority for this card):`,
    ...concepts,
    `</course_syllabus>`,
  ].join("\n");
}

/** Every key point and misconception correction on the card, with its source: the card's Sources list. */
export function cardSourceList(g: CardGround): Array<{ ref: string; text: string; source: CardSource }> {
  return g.concepts.flatMap(c => [
    ...c.keyPoints.map(k => ({ ref: k.ref, text: k.text, source: k.source })),
    ...c.misconceptions.map(m => ({ ref: m.ref, text: m.correction, source: m.source })),
  ]);
}

/** The card's misconceptions, by ref. */
export function misconceptionsByRef(g: CardGround): Map<string, GroundedMisconception> {
  return new Map(g.concepts.flatMap(c => c.misconceptions.map(m => [m.ref, m] as const)));
}

/** Every key point ref on the card. */
export function cardKeyPointRefs(g: CardGround): string[] {
  return g.concepts.flatMap(c => c.keyPoints.map(k => k.ref));
}

/**
 * The card's syllabus as the plain shape `lib/mastery/criteria.ts` takes
 * (`CriteriaSyllabus`), so mastery never imports a pack.
 */
export function criteriaSyllabus(g: CardGround): {
  keyPoints:      string[];
  misconceptions: Array<{ ref: string; claim: string; correction: string }>;
} {
  return {
    keyPoints:      g.concepts.flatMap(c => c.keyPoints.map(k => k.text)),
    misconceptions: g.concepts.flatMap(c => c.misconceptions.map(m => ({ ref: m.ref, claim: m.claim, correction: m.correction }))),
  };
}

/**
 * What the learner reads after holding a wrong belief: the course's own
 * correction and where it comes from (PRD row 4, "the feedback gives the
 * pack's correction and its source"). Written by the server from the pack,
 * never by the model, so the correction and the link are exactly the
 * source-checked ones. Empty when nothing was held.
 */
export function misconceptionFeedback(g: CardGround, heldRefs: readonly string[]): string {
  const byRef = misconceptionsByRef(g);
  return heldRefs.flatMap(ref => {
    const m = byRef.get(ref);
    if (!m) return [];
    const where = m.source.manual ? `${m.source.publisher}, ${m.source.locator}: ${m.source.href}` : `${m.source.publisher}: ${m.source.href}`;
    return [`Not yet: "${m.claim}" is a common misconception. ${m.correction} (Source: ${where})`];
  }).join("\n");
}

/** What a card's Sources section shows: the list, or why there is none. */
export type CardSourcesView =
  | { kind: "sources"; items: Array<{ ref: string; text: string; source: CardSource }> }
  | { kind: "problem"; message: string };

/**
 * The Sources section for every card on a board, keyed by milestone id.
 * Built on the server from each card's concept_ids and passed down as plain
 * data, so the browser never loads a pack or builds a link itself. A card
 * that can't be taught from a syllabus says why in that section, which for an
 * earlier topic is the read-only sentence the card's other surfaces also use.
 */
export function boardSources(
  cards: ReadonlyArray<{ id: string; concept_ids?: string[] | null }>,
): Record<string, CardSourcesView> {
  const out: Record<string, CardSourcesView> = {};
  for (const card of cards) {
    const g = cardGrounding(card.concept_ids);
    if (g.kind === "ok")      out[card.id] = { kind: "sources", items: cardSourceList(g.ground) };
    if (g.kind === "refused") out[card.id] = { kind: "problem", message: GROUNDING_REFUSAL_MESSAGE[g.reason] };
  }
  return out;
}
