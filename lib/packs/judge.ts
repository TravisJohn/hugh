// ── Reference packs: the machine check (spec v1.1) ──────────────────────────
// A blind judge reads each source passage beside our sentence and says whether
// the sentence says only what the passage supports. Planted errors, mixed in
// blind, prove on every run that the judge is really reading: one that calls a
// planted error "supported" has shown its approvals cannot be trusted.
//
// Pure apart from hashing: scripts/validate-pack.ts fetches the passages and
// moves the files, and the judge itself runs as a separate model call, in a
// fresh context, in the authoring session. See PRD-reference-packs.md.

import { createHash } from "node:crypto";
import type { PackAnchor, ReferencePack } from "@/types/pack";
import { wordCount } from "./anchor";

/** Bump whenever JUDGE_INSTRUCTIONS changes; every record names the version. */
export const JUDGE_INSTRUCTIONS_VERSION = "1";

export const JUDGE_INSTRUCTIONS = `You are checking whether short sentences are faithful to the source passages they claim to summarise.

Each item has an id, a PASSAGE taken from a published source, and a SENTENCE someone wrote about it. For every item, judge only this: does the SENTENCE say what the PASSAGE supports?

Verdicts:
- "supported": everything the sentence asserts is stated in the passage or follows directly from it. Plain-language paraphrase, simplification and leaving out detail are all fine.
- "partly": some of it is supported, but the sentence adds a claim the passage does not make, overstates it (for example "always", "guarantees", "proves", or a wider scope), or shifts its meaning.
- "not_supported": the passage does not back the sentence's main claim.
- "contradicts": the passage says the opposite.

Rules:
- Use only the passage. A sentence that is true in general but not supported by this passage is "not_supported". Do not fill gaps from your own knowledge.
- Judge each item on its own. Some sentences may be deliberately wrong; judge them exactly as you judge the rest.
- Give a reason of 25 words or fewer, in your own words. Never copy the passage into the reason.

Reply with only this JSON, covering every item exactly once:
{ "judgeModel": "<your model id>", "instructionsVersion": "${JUDGE_INSTRUCTIONS_VERSION}", "verdicts": [ { "id": "<item id>", "verdict": "supported" | "partly" | "not_supported" | "contradicts", "reason": "<25 words or fewer>" } ] }`;

export const JUDGE_VERDICTS = ["supported", "partly", "not_supported", "contradicts"] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];
export const REASON_MAX_WORDS = 25;

/** The kinds of corruption every run must plant, besides misconception claims. */
export const PLANT_TYPES = [
  "negation", "overstatement", "wrong_number_or_direction", "unsupported_addition", "causal_from_association",
] as const;
export type PlantType = (typeof PLANT_TYPES)[number];

/** A deliberately unfaithful copy of a real key point, judged against that key point's passage. */
export interface PlantedError {
  /** The key point whose passage the plant is judged against, as `conceptId:n`. */
  ref:      string;
  type:     PlantType;
  sentence: string;
}

/** Planted errors must be at least 5, or 10% of the real items if that is more. */
export function errorsRequired(itemsJudged: number): number {
  return Math.max(5, Math.ceil(itemsJudged * 0.1));
}

// ── What gets judged ────────────────────────────────────────────────────────

export interface JudgedItem {
  /** `conceptId:n` for a key point, `conceptId:mn` for a misconception's correction. */
  ref:      string;
  sentence: string;
  anchor:   PackAnchor;
}

/** The real items: every key point, and every misconception's correction. */
export function judgedItems(pack: ReferencePack): JudgedItem[] {
  return pack.concepts.flatMap(c => [
    ...c.keyPoints.map((k, i) => ({ ref: `${c.id}:${i + 1}`, sentence: k.text, anchor: k.anchor })),
    ...(c.misconceptions ?? []).map((m, i) => ({ ref: `${c.id}:m${i + 1}`, sentence: m.correction, anchor: m.anchor })),
  ]);
}

/**
 * A fingerprint of everything the judge looked at: each key point's text,
 * source and anchor, and each misconception's claim, correction, source and
 * anchor. Status, review and version are left out, so recording a check does
 * not change it, but any edit to what was judged does.
 */
export function fingerprint(pack: ReferencePack): string {
  const judged = pack.concepts.map(c => ({
    id: c.id,
    keyPoints: c.keyPoints.map(k => [k.text, k.sourceId, k.anchor.start, k.anchor.end]),
    misconceptions: (c.misconceptions ?? []).map(m => [m.claim, m.correction, m.sourceId, m.anchor.start, m.anchor.end]),
  }));
  return "sha256:" + createHash("sha256").update(JSON.stringify(judged)).digest("hex").slice(0, 32);
}

// ── Planted errors ──────────────────────────────────────────────────────────

/**
 * Read a pack's planted-errors file. Every corruption type must appear at
 * least once, every plant must point at a real key point, and a plant must
 * actually differ from the sentence it corrupts.
 */
export function parsePlants(pack: ReferencePack, raw: unknown): { plants: PlantedError[] | null; problems: string[] } {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { plants?: unknown }).plants)) {
    return { plants: null, problems: ["the planted-errors file needs a `plants` array"] };
  }
  const text = new Map<string, string>(
    pack.concepts.flatMap(c => c.keyPoints.map((k, i): [string, string] => [`${c.id}:${i + 1}`, k.text])),
  );
  const plants: PlantedError[] = [];
  (raw as { plants: unknown[] }).plants.forEach((p, i) => {
    const { ref, type, sentence } = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
    if (typeof ref !== "string" || !text.has(ref)) { problems.push(`plants[${i}].ref is not a key point`); return; }
    if (typeof type !== "string" || !(PLANT_TYPES as readonly string[]).includes(type)) { problems.push(`plants[${i}].type is not a known corruption`); return; }
    if (typeof sentence !== "string" || sentence.trim() === "") { problems.push(`plants[${i}].sentence is empty`); return; }
    if (sentence.trim() === text.get(ref)!.trim()) { problems.push(`plants[${i}] is identical to the key point it corrupts`); return; }
    plants.push({ ref, type: type as PlantType, sentence });
  });
  for (const t of PLANT_TYPES) if (!plants.some(p => p.type === t)) problems.push(`no planted "${t}" error`);
  return { plants: problems.length === 0 ? plants : null, problems };
}

// ── The packet the judge reads, and the key it never sees ───────────────────

export interface JudgeItem {
  id:       string;
  passage:  string;
  sentence: string;
}

export interface JudgePacket {
  instructionsVersion: string;
  instructions:        string;
  items:               JudgeItem[];
}

export type JudgeKeyEntry =
  | { id: string; ref: string; planted: false }
  | { id: string; ref: string; planted: true; kind: "misconception_claim" | PlantType };

export interface JudgeKey {
  packId:              string;
  instructionsVersion: string;
  fingerprint:         string;
  entries:             JudgeKeyEntry[];
}

export type BuiltPacket =
  | { ok: true; packet: JudgePacket; key: JudgeKey }
  | { ok: false; problems: string[] };

/**
 * Mix the real items and the planted errors, shuffle them, and give each an
 * opaque id, so nothing in the packet says which items are planted. `passages`
 * maps each anchor's ref (`conceptId:n` or `conceptId:mn`) to its passage.
 * `random` is injected so a test can pin the shuffle.
 */
export function buildJudgePacket(
  pack: ReferencePack, passages: ReadonlyMap<string, string>, plants: readonly PlantedError[], random: () => number,
): BuiltPacket {
  const problems: string[] = [];
  const passageFor = (ref: string): string => {
    const p = passages.get(ref);
    if (p === undefined) problems.push(`no passage for ${ref}`);
    return p ?? "";
  };

  type Draft = { passage: string; sentence: string; entry: Omit<JudgeKeyEntry, "id"> };
  const real = judgedItems(pack);
  const drafts: Draft[] = [
    ...real.map(r => ({ passage: passageFor(r.ref), sentence: r.sentence, entry: { ref: r.ref, planted: false as const } })),
    ...pack.concepts.flatMap(c => (c.misconceptions ?? []).map((m, i) => {
      const ref = `${c.id}:m${i + 1}`;
      return { passage: passageFor(ref), sentence: m.claim, entry: { ref, planted: true as const, kind: "misconception_claim" as const } };
    })),
    ...plants.map(p => ({ passage: passageFor(p.ref), sentence: p.sentence, entry: { ref: p.ref, planted: true as const, kind: p.type } })),
  ];
  const planted = drafts.length - real.length;
  if (planted < errorsRequired(real.length)) {
    problems.push(`${planted} planted errors; ${real.length} real items need at least ${errorsRequired(real.length)}`);
  }
  if (problems.length > 0) return { ok: false, problems };

  for (let i = drafts.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [drafts[i], drafts[j]] = [drafts[j], drafts[i]];
  }
  const width = String(drafts.length).length;
  const items: JudgeItem[] = [];
  const entries: JudgeKeyEntry[] = [];
  drafts.forEach((d, i) => {
    const id = `j${String(i + 1).padStart(width, "0")}`;
    items.push({ id, passage: d.passage, sentence: d.sentence });
    entries.push({ id, ...d.entry } as JudgeKeyEntry);
  });
  return {
    ok: true,
    packet: { instructionsVersion: JUDGE_INSTRUCTIONS_VERSION, instructions: JUDGE_INSTRUCTIONS, items },
    key: { packId: pack.id, instructionsVersion: JUDGE_INSTRUCTIONS_VERSION, fingerprint: fingerprint(pack), entries },
  };
}

// ── Reading and scoring the judge's verdicts ────────────────────────────────

export interface JudgeVerdictEntry {
  id:      string;
  verdict: JudgeVerdict;
  reason:  string;
}

export interface Judgement {
  judgeModel:          string;
  instructionsVersion: string;
  verdicts:            JudgeVerdictEntry[];
}

export function parseJudgement(raw: unknown): { judgement: Judgement | null; problems: string[] } {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null) return { judgement: null, problems: ["the judgement must be a JSON object"] };
  const { judgeModel, instructionsVersion, verdicts } = raw as Record<string, unknown>;
  if (typeof judgeModel !== "string" || judgeModel.trim() === "") problems.push("judgeModel must name the model");
  if (typeof instructionsVersion !== "string") problems.push("instructionsVersion is missing");
  if (!Array.isArray(verdicts)) return { judgement: null, problems: [...problems, "verdicts must be an array"] };
  const parsed: JudgeVerdictEntry[] = [];
  verdicts.forEach((v, i) => {
    const { id, verdict, reason } = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
    if (typeof id !== "string") { problems.push(`verdicts[${i}].id is missing`); return; }
    if (typeof verdict !== "string" || !(JUDGE_VERDICTS as readonly string[]).includes(verdict)) {
      problems.push(`verdicts[${i}] (${id}) has an unknown verdict`); return;
    }
    if (typeof reason !== "string" || reason.trim() === "") { problems.push(`verdicts[${i}] (${id}) has no reason`); return; }
    parsed.push({ id, verdict: verdict as JudgeVerdict, reason });
  });
  return problems.length > 0
    ? { judgement: null, problems }
    : { judgement: { judgeModel: judgeModel as string, instructionsVersion: instructionsVersion as string, verdicts: parsed }, problems };
}

export interface JudgementResult {
  passed:         boolean;
  itemsJudged:    number;
  itemsSupported: number;
  errorsPlanted:  number;
  errorsCaught:   number;
  /** Real items the judge did not call supported: rewrite, re-anchor, re-judge. */
  unsupported:    { ref: string; verdict: JudgeVerdict; reason: string }[];
  /** Planted errors the judge called supported: the run fails outright. */
  missedErrors:   { ref: string; kind: string; reason: string }[];
  /** Anything that makes the run itself invalid. */
  problems:       string[];
}

/**
 * Score a judgement against the key. The run passes only if the judge called
 * every real item supported, caught every planted error, answered every item
 * exactly once, kept its reasons short, and ran the current instructions.
 */
export function scoreJudgement(key: JudgeKey, judgement: Judgement): JudgementResult {
  const problems: string[] = [];
  if (judgement.instructionsVersion !== key.instructionsVersion) {
    problems.push(`the judge ran instructions v${judgement.instructionsVersion}; the packet was v${key.instructionsVersion}`);
  }
  const byId = new Map<string, JudgeVerdictEntry>();
  for (const v of judgement.verdicts) {
    if (byId.has(v.id)) problems.push(`${v.id} was judged twice`);
    byId.set(v.id, v);
    if (wordCount(v.reason) > REASON_MAX_WORDS) problems.push(`${v.id}'s reason is over ${REASON_MAX_WORDS} words`);
  }
  const known = new Set(key.entries.map(e => e.id));
  for (const id of byId.keys()) if (!known.has(id)) problems.push(`${id} is not an item in the packet`);

  const result: JudgementResult = {
    passed: false, itemsJudged: 0, itemsSupported: 0, errorsPlanted: 0, errorsCaught: 0,
    unsupported: [], missedErrors: [], problems,
  };
  for (const e of key.entries) {
    const v = byId.get(e.id);
    if (!v) { problems.push(`${e.id} (${e.ref}) has no verdict`); continue; }
    if (e.planted) {
      result.errorsPlanted++;
      if (v.verdict === "supported") result.missedErrors.push({ ref: e.ref, kind: e.kind, reason: v.reason });
      else result.errorsCaught++;
    } else {
      result.itemsJudged++;
      if (v.verdict === "supported") result.itemsSupported++;
      else result.unsupported.push({ ref: e.ref, verdict: v.verdict, reason: v.reason });
    }
  }
  if (result.errorsPlanted < errorsRequired(result.itemsJudged)) {
    problems.push(`only ${result.errorsPlanted} planted errors for ${result.itemsJudged} items`);
  }
  result.passed = problems.length === 0 && result.unsupported.length === 0 && result.missedErrors.length === 0;
  return result;
}
