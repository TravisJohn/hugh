import { describe, it, expect } from "vitest";
import {
  boardSources, cardGrounding, cardKeyPointRefs, cardSourceList, criteriaSyllabus, GROUNDING_REFUSAL_MESSAGE, misconceptionFeedback,
  groundFromPack, misconceptionsByRef, renderCardSyllabus, type CardGround,
} from "./grounding";
import { packTrack } from "./track";
import linearRegression from "@/content/packs/linear-regression.json";
import type { ReferencePack } from "@/types/pack";

const pack = linearRegression as ReferencePack;
const rows = packTrack(pack).rows;
const collinearityCard = rows.find(r => r.concept_ids.includes("linear-regression:collinearity"))!;

function grounded(ids: readonly string[]): CardGround {
  const g = cardGrounding(ids);
  if (g.kind !== "ok") throw new Error(`expected ok, got ${g.kind}`);
  return g.ground;
}

describe("cardGrounding: which cards are course cards", () => {
  it("leaves a card with no concept ids alone, so every open-topic card behaves as before", () => {
    expect(cardGrounding([])).toEqual({ kind: "none" });
    expect(cardGrounding(null)).toEqual({ kind: "none" });
    expect(cardGrounding(undefined)).toEqual({ kind: "none" });
  });

  it("grounds every card the Linear Regression build writes", () => {
    for (const row of rows) expect(cardGrounding(row.concept_ids).kind).toBe("ok");
  });

  it("refuses a card naming concepts from two courses, rather than picking one", () => {
    expect(cardGrounding(["linear-regression:least_squares", "ab-testing:power"]))
      .toEqual({ kind: "refused", reason: "mixed-packs" });
  });

  it("refuses an unqualified or unknown concept id, rather than teaching around it", () => {
    expect(cardGrounding(["least_squares"])).toEqual({ kind: "refused", reason: "unknown-concept" });
    expect(cardGrounding(["linear-regression:no_such_concept"])).toEqual({ kind: "refused", reason: "unknown-concept" });
  });

  it("refuses a course that is not in the catalog", () => {
    expect(cardGrounding(["not-a-course:x"])).toEqual({ kind: "refused", reason: "unknown" });
  });

  it("gives every refusal its own message", () => {
    const messages = Object.values(GROUNDING_REFUSAL_MESSAGE);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("the grounding of one card", () => {
  const g = grounded(collinearityCard.concept_ids);

  it("carries the card's key points and misconceptions, with the refs the checklist uses", () => {
    const concept = pack.concepts.find(c => c.id === "collinearity")!;
    expect(cardKeyPointRefs(g)).toEqual(concept.keyPoints.map((_, i) => `collinearity:${i + 1}`));
    expect([...misconceptionsByRef(g).keys()]).toEqual((concept.misconceptions ?? []).map((_, i) => `collinearity:m${i + 1}`));
  });

  it("lists every other card, so Ask can point to the right one", () => {
    expect(g.otherCards).toHaveLength(rows.length - 1);
    expect(g.otherCards.map(c => c.title)).not.toContain(collinearityCard.title);
  });

  it("links each source to its highlighted passage", () => {
    const src = g.concepts[0]!.keyPoints[0]!.source;
    expect(src.manual).toBe(false);
    expect(src.href).toContain("#:~:text=");
    expect(src.publisher.length).toBeGreaterThan(0);
  });
});

describe("PDF sources", () => {
  it("link the PDF plainly and mark it manual, because a PDF cannot highlight a passage", () => {
    const p: ReferencePack = JSON.parse(JSON.stringify(pack));
    const kp = p.concepts[0]!.keyPoints[0]!;
    p.sources = p.sources.map(s => s.id === kp.sourceId ? { ...s, url: "https://example.org/notes.pdf?v=2" } : s);
    const g = groundFromPack(p, [p.concepts[0]!.id]);
    if (g.kind !== "ok") throw new Error("expected ok");
    expect(g.ground.concepts[0]!.keyPoints[0]!.source).toMatchObject({ manual: true, href: "https://example.org/notes.pdf?v=2" });
  });
});

describe("renderCardSyllabus", () => {
  const g = grounded(collinearityCard.concept_ids);
  const text = renderCardSyllabus(g);

  it("states every key point and misconception by ref, so a judge and a quiz can name them", () => {
    for (const ref of cardKeyPointRefs(g)) expect(text).toContain(`[${ref}]`);
    for (const [ref, m] of misconceptionsByRef(g)) {
      expect(text).toContain(`[${ref}] Wrong belief: ${m.claim}`);
      expect(text).toContain(`Correction: ${m.correction}`);
    }
  });

  it("names what the course does not cover, so out-of-syllabus questions can be labelled", () => {
    for (const item of pack.outOfScope) expect(text).toContain(item);
  });

  it("is the same text every time for a card, so it can sit in a cached prefix", () => {
    expect(renderCardSyllabus(grounded(collinearityCard.concept_ids))).toBe(text);
  });

  it("never carries a link, so no model is shown a URL to repeat", () => {
    expect(text).not.toMatch(/https?:\/\//);
  });
});

describe("cardSourceList", () => {
  it("lists every key point and every correction once, each with its source", () => {
    const g = grounded(collinearityCard.concept_ids);
    const list = cardSourceList(g);
    expect(list).toHaveLength(cardKeyPointRefs(g).length + misconceptionsByRef(g).size);
    expect(list.every(item => item.source.href.length > 0)).toBe(true);
  });
});

describe("criteriaSyllabus", () => {
  it("hands mastery the card's key points and wrong beliefs, in order", () => {
    const g = grounded(collinearityCard.concept_ids);
    const s = criteriaSyllabus(g);
    expect(s.keyPoints).toEqual(g.concepts.flatMap(c => c.keyPoints.map(k => k.text)));
    expect(s.misconceptions.map(m => m.ref)).toEqual([...misconceptionsByRef(g).keys()]);
  });
});

describe("misconceptionFeedback", () => {
  const g = grounded(collinearityCard.concept_ids);
  const [ref, m] = [...misconceptionsByRef(g)][0]!;

  it("gives the course's own correction and its source link for a held belief", () => {
    const text = misconceptionFeedback(g, [ref]);
    expect(text).toContain(m.claim);
    expect(text).toContain(m.correction);
    expect(text).toContain(m.source.href);
  });

  it("says nothing when no belief was held, or the ref is not on the card", () => {
    expect(misconceptionFeedback(g, [])).toBe("");
    expect(misconceptionFeedback(g, ["nowhere:m1"])).toBe("");
  });
});

describe("boardSources", () => {
  it("gives each course card its sources, a broken one its problem, and leaves other cards out", () => {
    const view = boardSources([
      { id: "course", concept_ids: collinearityCard.concept_ids },
      { id: "broken", concept_ids: ["linear-regression:gone"] },
      { id: "open-topic", concept_ids: [] },
      { id: "older-row" },
    ]);
    expect(Object.keys(view).sort()).toEqual(["broken", "course"]);
    expect(view.course!.kind).toBe("sources");
    expect(view.broken).toEqual({ kind: "problem", message: GROUNDING_REFUSAL_MESSAGE["unknown-concept"] });
  });
});
