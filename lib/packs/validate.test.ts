import { describe, it, expect } from "vitest";
import type { PackConcept, ReferencePack } from "@/types/pack";
import {
  anchorTargets, checkPack, learningOrder, parsePack, sampleKeyPoints,
  type PackIssue,
} from "./validate";
import { errorsRequired, fingerprint, judgedItems } from "./judge";

// One valid pack; each test breaks exactly one thing, so a failure names the
// rule it is about.
function concept(id: string, over: Partial<PackConcept> = {}): PackConcept {
  return {
    id, title: `Concept ${id}`, outcome: `Explain ${id}.`,
    keyPoints: [
      { text: `First point about ${id}.`,  sourceId: "src", locator: "Lesson 1", anchor: { start: "first two words", end: "last two words" } },
      { text: `Second point about ${id}.`, sourceId: "src", locator: "Lesson 1", anchor: { start: "other two words", end: "closing two words" } },
    ],
    ...over,
  };
}

function pack(over: Partial<ReferencePack> = {}): ReferencePack {
  return {
    id: "linear-regression", version: "2.0.0", status: "draft", subject: "Linear regression",
    outOfScope: ["Generalised linear models"],
    sources: [{ id: "src", title: "Notes", publisher: "A University", url: "https://example.edu/notes", accessedAt: "2026-10-19" }],
    concepts: [concept("a"), concept("b")],
    prerequisites: [{ before: "a", after: "b", reason: "b builds on a." }],
    ...over,
  };
}

/** The pack, with a passed machine check that truly matches it. */
function checked(p: ReferencePack): ReferencePack {
  const items = judgedItems(p).length;
  return {
    ...p,
    machineCheck: {
      judgeModel: "claude-test", instructionsVersion: "1", checkedAt: "2026-10-20",
      itemsJudged: items, itemsSupported: items,
      errorsPlanted: errorsRequired(items), errorsCaught: errorsRequired(items),
      fingerprint: fingerprint(p),
    },
  };
}

const errors   = (issues: PackIssue[]) => issues.filter(i => i.level === "error");
const warnings = (issues: PackIssue[]) => issues.filter(i => i.level === "warning");

describe("parsePack", () => {
  it("accepts a complete pack and returns it unchanged", () => {
    const p = pack();
    expect(parsePack(JSON.parse(JSON.stringify(p)))).toEqual({ pack: p, issues: [] });
  });

  it("reports every missing field in one run, so an author fixes the file once", () => {
    const { pack: parsed, issues } = parsePack({ id: "x", status: "draft" });
    expect(parsed).toBeNull();
    expect(issues.map(i => i.path)).toEqual(
      expect.arrayContaining(["$.version", "$.subject", "$.outOfScope", "$.sources", "$.concepts", "$.prerequisites"]),
    );
  });

  it("rejects an unknown status rather than treating it as draft", () => {
    expect(parsePack({ ...pack(), status: "done" }).issues).toContainEqual(
      { level: "error", path: "$.status", message: "must be draft, provisional, machine-checked or approved" },
    );
  });

  it("names the exact field when a nested anchor is incomplete", () => {
    const raw = JSON.parse(JSON.stringify(pack()));
    delete raw.concepts[1].keyPoints[0].anchor.end;
    expect(parsePack(raw).issues.map(i => i.path)).toContain("$.concepts[1].keyPoints[0].anchor.end");
  });

  it("rejects something that is not an object at all", () => {
    expect(parsePack([]).pack).toBeNull();
  });
});

describe("checkPack", () => {
  it("passes a pack that meets every rule", () => {
    expect(checkPack(pack())).toEqual([]);
  });

  it("requires at least two key points, because one point is a definition, not a concept", () => {
    const thin = concept("a", { keyPoints: concept("a").keyPoints.slice(0, 1) });
    expect(errors(checkPack(pack({ concepts: [thin, concept("b")] })))[0].path).toBe("concepts[0].keyPoints");
  });

  it("caps key points at five, so a concept stays small enough to ground an answer", () => {
    const k = concept("a").keyPoints[0];
    const fat = concept("a", { keyPoints: Array.from({ length: 6 }, (_, i) => ({ ...k, anchor: { start: `start words ${i}`, end: "end words" } })) });
    expect(errors(checkPack(pack({ concepts: [fat, concept("b")] }))).map(i => i.path)).toContain("concepts[0].keyPoints");
  });

  it("rejects a key point over forty words, because key points are summaries, not copied passages", () => {
    const long = concept("a");
    long.keyPoints[0] = { ...long.keyPoints[0], text: "word ".repeat(41) };
    expect(errors(checkPack(pack({ concepts: [long, concept("b")] })))[0].path).toBe("concepts[0].keyPoints[0].text");
  });

  it("rejects an anchor longer than six words, so anchors locate a passage rather than copy it", () => {
    const c = concept("a");
    c.keyPoints[0] = { ...c.keyPoints[0], anchor: { start: "one two three four five six seven", end: "end words" } };
    expect(errors(checkPack(pack({ concepts: [c, concept("b")] })))[0].path).toBe("concepts[0].keyPoints[0].anchor.start");
  });

  it("rejects a one-word anchor, because a single word cannot pin down a passage", () => {
    const c = concept("a");
    c.keyPoints[1] = { ...c.keyPoints[1], anchor: { start: "two words", end: "single" } };
    expect(errors(checkPack(pack({ concepts: [c, concept("b")] })))[0].path).toBe("concepts[0].keyPoints[1].anchor.end");
  });

  it("rejects a citation to a source the pack does not list", () => {
    const c = concept("a");
    c.keyPoints[0] = { ...c.keyPoints[0], sourceId: "ghost" };
    expect(errors(checkPack(pack({ concepts: [c, concept("b")] })))[0].message).toBe("\"ghost\" is not in sources");
  });

  it("checks misconceptions' citations and anchors like key points", () => {
    const c = concept("a", { misconceptions: [{
      claim: "VIF removes collinearity.", correction: "VIF measures it.",
      sourceId: "ghost", locator: "Lesson 12", anchor: { start: "too", end: "short end words" },
    }] });
    expect(errors(checkPack(pack({ concepts: [c, concept("b")] }))).map(i => i.path)).toEqual([
      "concepts[0].misconceptions[0].sourceId",
      "concepts[0].misconceptions[0].anchor.start",
    ]);
  });

  it("warns about a listed source nobody cites, without blocking the pack", () => {
    const extra = { id: "unused", title: "T", publisher: "P", url: "https://example.org", accessedAt: "2026-10-19" };
    const issues = checkPack(pack({ sources: [...pack().sources, extra] }));
    expect(errors(issues)).toEqual([]);
    expect(warnings(issues)[0].message).toBe("\"unused\" is never cited");
  });

  it("rejects a non-https source and an impossible access date", () => {
    const bad = { id: "src", title: "T", publisher: "P", url: "http://example.org", accessedAt: "2026-02-30" };
    expect(errors(checkPack(pack({ sources: [bad] }))).map(i => i.path)).toEqual(["sources[0].url", "sources[0].accessedAt"]);
  });

  it("rejects duplicate concept ids, because prerequisites and samples refer to concepts by id", () => {
    expect(errors(checkPack(pack({ concepts: [concept("a"), concept("a")] })))[0].message).toBe("duplicate concept id \"a\"");
  });

  it("rejects a prerequisite naming a concept that does not exist", () => {
    const issues = checkPack(pack({ prerequisites: [{ before: "a", after: "zzz", reason: "r" }] }));
    expect(errors(issues)[0].path).toBe("prerequisites[0].after");
  });

  it("rejects prerequisites that loop, since no learning order could satisfy them", () => {
    const loop = [{ before: "a", after: "b", reason: "r" }, { before: "b", after: "a", reason: "r" }];
    expect(errors(checkPack(pack({ prerequisites: loop })))[0].message).toBe("form a loop through: a, b");
  });

  it("refuses an approved pack with no recorded spot-check", () => {
    expect(errors(checkPack(checked(pack({ status: "approved" }))))[0].path).toBe("$.review");
  });

  it("refuses an approval whose sample is under five distinct key points", () => {
    const review = { reviewedBy: "Travis", reviewedAt: "2026-10-20", sampledKeyPoints: ["a:1", "a:1", "a:2", "b:1"] };
    expect(errors(checkPack(checked(pack({ status: "approved", review }))))[0].message).toBe("needs at least 5 distinct key points");
  });

  it("accepts an approval that sampled five real key points", () => {
    const review = { reviewedBy: "Travis", reviewedAt: "2026-10-20", sampledKeyPoints: ["a:1", "a:2", "b:1", "b:2", "c:1"] };
    const p = pack({ status: "approved", review, concepts: [concept("a"), concept("b"), concept("c")] });
    expect(checkPack(checked(p))).toEqual([]);
  });

  it("rejects a sampled ref that names no key point, so a review cannot cite checks that never happened", () => {
    const review = { reviewedBy: "Travis", reviewedAt: "2026-10-20", sampledKeyPoints: ["a:1", "a:2", "b:1", "b:2", "b:9"] };
    expect(errors(checkPack(checked(pack({ status: "approved", review }))))[0].message).toBe("\"b:9\" is not a key point");
  });
});

describe("checkPack: the machine check (spec v1.1)", () => {
  it("accepts a machine-checked pack whose record matches it", () => {
    expect(checkPack(checked(pack({ status: "machine-checked" })))).toEqual([]);
  });

  it("refuses machine-checked with no record, because the status must be earned by a run", () => {
    expect(errors(checkPack(pack({ status: "machine-checked" })))[0].path).toBe("$.machineCheck");
  });

  it("refuses an approved pack with no machine check, since approval now audits the judge", () => {
    const review = { reviewedBy: "Travis", reviewedAt: "2026-10-20", sampledKeyPoints: ["a:1", "a:2", "b:1", "b:2", "a:1"] };
    expect(errors(checkPack(pack({ status: "approved", review }))).map(e => e.path)).toContain("$.machineCheck");
  });

  it("catches a key point edited after the check, so a judged pack cannot be quietly changed", () => {
    const p = checked(pack({ status: "machine-checked" }));
    p.concepts[0].keyPoints[0] = { ...p.concepts[0].keyPoints[0], text: "Edited after judging." };
    expect(errors(checkPack(p))[0].message).toMatch(/changed after the machine check; set status to provisional/);
  });

  it("refuses a record where the judge did not support every item", () => {
    const p = checked(pack({ status: "machine-checked" }));
    p.machineCheck = { ...p.machineCheck!, itemsSupported: p.machineCheck!.itemsJudged - 1 };
    expect(errors(checkPack(p))[0].path).toBe("$.machineCheck.itemsSupported");
  });

  it("refuses a record where a planted error got through", () => {
    const p = checked(pack({ status: "machine-checked" }));
    p.machineCheck = { ...p.machineCheck!, errorsCaught: p.machineCheck!.errorsPlanted - 1 };
    expect(errors(checkPack(p))[0].path).toBe("$.machineCheck.errorsCaught");
  });

  it("refuses a record with too few planted errors to have proved anything", () => {
    const p = checked(pack({ status: "machine-checked" }));
    p.machineCheck = { ...p.machineCheck!, errorsPlanted: 2, errorsCaught: 2 };
    expect(errors(checkPack(p))[0].path).toBe("$.machineCheck.errorsPlanted");
  });

  it("only warns about a record left on a provisional pack", () => {
    const issues = checkPack(checked(pack({ status: "provisional" })));
    expect(errors(issues)).toEqual([]);
    expect(warnings(issues)[0].path).toBe("$.machineCheck");
  });
});

// Eight concepts, one card each: the smallest board the rules allow.
const EIGHT = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
function carded(over: Partial<ReferencePack> = {}): ReferencePack {
  return pack({
    concepts:      EIGHT.map(id => concept(id)),
    prerequisites: [{ before: "c1", after: "c2", reason: "c2 builds on c1." }],
    cards:         EIGHT.map(id => ({ id: `card-${id}`, title: `Card ${id}`, conceptIds: [id] })),
    ...over,
  });
}
const cardErrors = (p: ReferencePack) => errors(checkPack(p)).filter(i => i.path.startsWith("$.cards") || i.path.startsWith("cards["));

describe("checkPack: cards (spec v1.2)", () => {
  it("accepts cards that cover every concept once, in an order the prerequisites allow", () => {
    expect(errors(checkPack(carded()))).toEqual([]);
  });

  it("reads cards and a retired flag back unchanged, so the format round-trips", () => {
    const p = carded({ concepts: [...EIGHT.map(id => concept(id)), concept("old", { retired: true })] });
    expect(parsePack(JSON.parse(JSON.stringify(p)))).toEqual({ pack: p, issues: [] });
  });

  it("rejects a retired flag that is anything but true, so 'retired: false' cannot hide a typo", () => {
    const raw = JSON.parse(JSON.stringify(carded()));
    raw.concepts[0].retired = false;
    expect(parsePack(raw).issues.map(i => i.path)).toContain("$.concepts[0].retired");
  });

  it("needs 8 to 14 cards, so a board fits the no-scroll track screen", () => {
    const seven = carded();
    seven.cards = [{ id: "both", title: "Both", conceptIds: ["c1", "c2"] }, ...seven.cards!.slice(2)];
    expect(cardErrors(seven).map(e => e.message)).toContain("needs 8-14 cards, has 7");
  });

  it("caps a card at four concepts and refuses an empty one, so a card stays one sitting", () => {
    const p = carded();
    p.cards![0] = { id: "card-c1", title: "Too many", conceptIds: ["c1", "c2", "c3", "c4", "c5"] };
    p.cards![1] = { id: "card-c2", title: "Empty", conceptIds: [] };
    const messages = cardErrors(p).map(e => e.message);
    expect(messages).toContain("needs 1-4 concepts, has 5");
    expect(messages).toContain("needs 1-4 concepts, has 0");
  });

  it("refuses a concept on two cards, because a card's progress must belong to one place", () => {
    const p = carded();
    p.cards![2] = { id: "card-c3", title: "Card c3", conceptIds: ["c3", "c1"] };
    expect(cardErrors(p).map(e => e.message)).toContain(`"c1" is already on cards[0]`);
  });

  it("refuses a live concept left off every card, so the track teaches the whole syllabus", () => {
    const p = carded({ concepts: [...EIGHT.map(id => concept(id)), concept("orphan")] });
    expect(cardErrors(p).map(e => e.message)).toContain(`concept "orphan" is on no card`);
  });

  it("refuses a card that teaches a concept before its prerequisite", () => {
    const p = carded();
    p.cards = [p.cards![1]!, p.cards![0]!, ...p.cards!.slice(2)];
    expect(cardErrors(p).map(e => e.message)).toContain(`"c1" (cards[1]) must come before "c2" (cards[0])`);
  });

  it("allows a prerequisite and its dependant on the same card, taught in order", () => {
    const p = carded({ concepts: [...EIGHT.map(id => concept(id)), concept("c9")] });
    p.prerequisites.push({ before: "c8", after: "c9", reason: "c9 builds on c8." });
    p.cards![7] = { id: "card-c8", title: "Card c8", conceptIds: ["c8", "c9"] };
    expect(cardErrors(p)).toEqual([]);
  });

  it("keeps a retired concept off every card, and does not demand a card for it", () => {
    const retired = carded({ concepts: [...EIGHT.map(id => concept(id)), concept("old", { retired: true })] });
    expect(cardErrors(retired)).toEqual([]);
    retired.cards![0] = { id: "card-c1", title: "Card c1", conceptIds: ["c1", "old"] };
    expect(cardErrors(retired).map(e => e.message)).toContain(`"old" is retired and cannot be taught`);
  });

  it("refuses an unknown concept and a duplicate card id", () => {
    const p = carded();
    p.cards![0] = { id: "card-c2", title: "Card c1", conceptIds: ["c1", "ghost"] };
    const messages = cardErrors(p).map(e => e.message);
    expect(messages).toContain(`"ghost" is not a concept`);
    expect(messages).toContain(`duplicate card id "card-c2"`);
  });

  it("leaves the machine-check fingerprint alone, so adding cards keeps a judged pack judged", () => {
    const bare = carded();
    delete bare.cards;
    expect(fingerprint(carded())).toBe(fingerprint(bare));
    expect(errors(checkPack(checked(carded({ status: "machine-checked" }))))).toEqual([]);
  });
});

describe("learningOrder", () => {
  it("honours prerequisites and otherwise keeps the pack's own order", () => {
    const order = learningOrder(["c", "b", "a"], [{ before: "a", after: "c", reason: "r" }]);
    expect(order).toEqual({ ok: true, order: ["b", "a", "c"] });
  });

  it("names only the concepts caught in a loop, so the author knows which edge to cut", () => {
    const order = learningOrder(["a", "b", "c", "d"], [
      { before: "b", after: "c", reason: "r" }, { before: "c", after: "d", reason: "r" }, { before: "d", after: "b", reason: "r" },
    ]);
    expect(order).toEqual({ ok: false, cycle: ["b", "c", "d"] });
  });
});

describe("anchorTargets", () => {
  it("lists key points as concept:n and misconceptions as concept:mn, counting from one", () => {
    const c = concept("a", { misconceptions: [{
      claim: "x", correction: "y", sourceId: "src", locator: "L", anchor: { start: "s1 s2", end: "e1 e2" },
    }] });
    expect(anchorTargets(pack({ concepts: [c] })).map(t => t.ref)).toEqual(["a:1", "a:2", "a:m1"]);
  });
});

describe("sampleKeyPoints", () => {
  it("draws distinct key points, and the same draw for the same random sequence", () => {
    const p = pack({ concepts: [concept("a"), concept("b"), concept("c")] });
    const seq = () => { let n = 0; return () => ((n++ * 0.37) % 1); };
    const first = sampleKeyPoints(p, 5, seq());
    expect(new Set(first).size).toBe(5);
    expect(sampleKeyPoints(p, 5, seq())).toEqual(first);
  });

  it("returns every key point when asked for more than exist", () => {
    expect(sampleKeyPoints(pack(), 50, () => 0.5)).toHaveLength(4);
  });
});
