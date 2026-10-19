import { describe, it, expect } from "vitest";
import type { PackConcept, ReferencePack } from "@/types/pack";
import {
  JUDGE_INSTRUCTIONS, JUDGE_INSTRUCTIONS_VERSION, PLANT_TYPES,
  buildJudgePacket, errorsRequired, fingerprint, judgedItems, parseJudgement, parsePlants, scoreJudgement,
  type JudgeKey, type Judgement, type PlantedError,
} from "./judge";

const anchor = { start: "first two words", end: "last two words" };
function concept(id: string, withMisconception = false): PackConcept {
  return {
    id, title: id, outcome: `Explain ${id}.`,
    keyPoints: [
      { text: `${id} point one.`, sourceId: "src", locator: "L1", anchor },
      { text: `${id} point two.`, sourceId: "src", locator: "L1", anchor },
    ],
    ...(withMisconception ? { misconceptions: [{ claim: `${id} wrong belief.`, correction: `${id} right answer.`, sourceId: "src", locator: "L1", anchor }] } : {}),
  };
}
function pack(concepts = [concept("a", true), concept("b")]): ReferencePack {
  return {
    id: "demo", version: "1.0.0", status: "provisional", subject: "Demo", outOfScope: [],
    sources: [{ id: "src", title: "T", publisher: "P", url: "https://example.edu", accessedAt: "2026-10-20" }],
    concepts, prerequisites: [],
  };
}
const plants: PlantedError[] = PLANT_TYPES.map(type => ({ ref: "b:1", type, sentence: `b point one, corrupted by ${type}.` }));
const passages = new Map([["a:1", "Passage A1."], ["a:2", "Passage A2."], ["a:m1", "Passage AM1."], ["b:1", "Passage B1."], ["b:2", "Passage B2."]]);
const fixed = () => 0.42;

describe("errorsRequired", () => {
  it("needs at least five planted errors however small the pack", () => {
    expect(errorsRequired(5)).toBe(5);
  });
  it("needs ten percent of the real items once that is more than five, rounded up", () => {
    expect(errorsRequired(77)).toBe(8);
  });
});

describe("judgedItems", () => {
  it("judges every key point and every misconception's correction, never the wrong claim itself", () => {
    expect(judgedItems(pack()).map(i => [i.ref, i.sentence])).toEqual([
      ["a:1", "a point one."], ["a:2", "a point two."], ["a:m1", "a right answer."],
      ["b:1", "b point one."], ["b:2", "b point two."],
    ]);
  });
});

describe("fingerprint", () => {
  it("does not change when only the status changes, so recording a check cannot break it", () => {
    expect(fingerprint({ ...pack(), status: "machine-checked" })).toBe(fingerprint(pack()));
  });
  it("changes when a key point's wording changes, so an edit after the check is caught", () => {
    const edited = pack();
    edited.concepts[1].keyPoints[0] = { ...edited.concepts[1].keyPoints[0], text: "Reworded." };
    expect(fingerprint(edited)).not.toBe(fingerprint(pack()));
  });
  it("changes when a misconception's correction changes", () => {
    const edited = pack();
    edited.concepts[0].misconceptions![0] = { ...edited.concepts[0].misconceptions![0], correction: "Different." };
    expect(fingerprint(edited)).not.toBe(fingerprint(pack()));
  });
});

describe("parsePlants", () => {
  it("accepts one planted error of every kind, each pointing at a real key point", () => {
    expect(parsePlants(pack(), { plants })).toEqual({ plants, problems: [] });
  });
  it("requires every kind of corruption, so a run cannot skip the hard ones", () => {
    expect(parsePlants(pack(), { plants: plants.slice(1) }).problems).toContain('no planted "negation" error');
  });
  it("refuses a plant aimed at something that is not a key point", () => {
    expect(parsePlants(pack(), { plants: [...plants, { ref: "a:m1", type: "negation", sentence: "x" }] }).problems)
      .toContain("plants[5].ref is not a key point");
  });
  it("refuses a plant identical to the sentence it claims to corrupt", () => {
    expect(parsePlants(pack(), { plants: [...plants, { ref: "a:1", type: "negation", sentence: "a point one." }] }).problems)
      .toContain("plants[5] is identical to the key point it corrupts");
  });
});

describe("buildJudgePacket", () => {
  it("mixes real items, misconception claims and plants, with nothing in an item saying which is which", () => {
    const built = buildJudgePacket(pack(), passages, plants, fixed);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.packet.items).toHaveLength(5 + 1 + 5);
    for (const item of built.packet.items) expect(Object.keys(item).sort()).toEqual(["id", "passage", "sentence"]);
    expect(built.packet.items.map(i => i.id)).toEqual(["j01", "j02", "j03", "j04", "j05", "j06", "j07", "j08", "j09", "j10", "j11"]);
    expect(built.packet.instructions).toBe(JUDGE_INSTRUCTIONS);
  });

  it("keeps the answer key separate, mapping every opaque id back to what it is", () => {
    const built = buildJudgePacket(pack(), passages, plants, fixed);
    if (!built.ok) throw new Error("expected a packet");
    const claim = built.key.entries.find(e => e.planted && e.kind === "misconception_claim")!;
    const item = built.packet.items.find(i => i.id === claim.id)!;
    expect(item).toEqual({ id: claim.id, passage: "Passage AM1.", sentence: "a wrong belief." });
    expect(built.key.fingerprint).toBe(fingerprint(pack()));
  });

  it("refuses to build a packet when a passage is missing, rather than judging against nothing", () => {
    const partial = new Map(passages);
    partial.delete("b:2");
    expect(buildJudgePacket(pack(), partial, plants, fixed)).toEqual({ ok: false, problems: ["no passage for b:2"] });
  });

  it("refuses a run with too few planted errors to prove anything", () => {
    expect(buildJudgePacket(pack(), passages, plants.slice(0, 2), fixed))
      .toEqual({ ok: false, problems: ["3 planted errors; 5 real items need at least 5"] });
  });
});

describe("parseJudgement", () => {
  it("refuses a verdict outside the four allowed", () => {
    const parsed = parseJudgement({ judgeModel: "m", instructionsVersion: "1", verdicts: [{ id: "j1", verdict: "fine", reason: "ok" }] });
    expect(parsed.problems).toEqual(["verdicts[0] (j1) has an unknown verdict"]);
  });
  it("requires the judge to name its model, so the record says who checked", () => {
    expect(parseJudgement({ judgeModel: "", instructionsVersion: "1", verdicts: [] }).problems).toContain("judgeModel must name the model");
  });
});

describe("scoreJudgement", () => {
  const built = buildJudgePacket(pack(), passages, plants, fixed);
  if (!built.ok) throw new Error("expected a packet");
  const key: JudgeKey = built.key;
  const honest = (): Judgement => ({
    judgeModel: "claude-test", instructionsVersion: JUDGE_INSTRUCTIONS_VERSION,
    verdicts: key.entries.map(e => ({ id: e.id, verdict: e.planted ? "not_supported" : "supported", reason: "Checked against the passage." })),
  });

  it("passes a run that supports every real item and catches every planted error", () => {
    expect(scoreJudgement(key, honest())).toMatchObject({
      passed: true, itemsJudged: 5, itemsSupported: 5, errorsPlanted: 6, errorsCaught: 6, problems: [],
    });
  });

  it("fails the run when a planted error is called supported, because the judge is not really reading", () => {
    const j = honest();
    const plant = key.entries.find(e => e.planted)!;
    j.verdicts.find(v => v.id === plant.id)!.verdict = "supported";
    const result = scoreJudgement(key, j);
    expect(result.passed).toBe(false);
    expect(result.missedErrors).toEqual([{ ref: plant.ref, kind: (plant as { kind: string }).kind, reason: "Checked against the passage." }]);
  });

  it("lists a real item judged only partly supported, so it can be rewritten", () => {
    const j = honest();
    const realItem = key.entries.find(e => !e.planted)!;
    Object.assign(j.verdicts.find(v => v.id === realItem.id)!, { verdict: "partly", reason: "Overstates the passage." });
    const result = scoreJudgement(key, j);
    expect(result.passed).toBe(false);
    expect(result.unsupported).toEqual([{ ref: realItem.ref, verdict: "partly", reason: "Overstates the passage." }]);
  });

  it("invalidates a run that skipped an item", () => {
    const j = honest();
    j.verdicts.pop();
    expect(scoreJudgement(key, j).problems[0]).toMatch(/has no verdict$/);
  });

  it("invalidates a run that judged an item twice", () => {
    const j = honest();
    j.verdicts.push({ ...j.verdicts[0] });
    expect(scoreJudgement(key, j).problems).toContain(`${j.verdicts[0].id} was judged twice`);
  });

  it("invalidates a run whose reasons run long enough to be copying the passage", () => {
    const j = honest();
    j.verdicts[0].reason = "word ".repeat(26);
    expect(scoreJudgement(key, j).passed).toBe(false);
  });

  it("invalidates a run made with different instructions from the packet's", () => {
    expect(scoreJudgement(key, { ...honest(), instructionsVersion: "0" }).problems[0]).toMatch(/instructions v0/);
  });
});
