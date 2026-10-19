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
