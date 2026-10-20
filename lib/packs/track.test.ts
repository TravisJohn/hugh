import { describe, it, expect } from "vitest";
import { packTrack, parseQualifiedConceptId, qualifiedConceptId } from "./track";
import linearRegression from "@/content/packs/linear-regression.json";
import type { ReferencePack } from "@/types/pack";

const pack = linearRegression as ReferencePack;

describe("packTrack: the Linear Regression board", () => {
  const { trackTitle, rows } = packTrack(pack);

  it("lays out one milestone per card, in the pack's teaching order", () => {
    expect(rows.map(r => r.title)).toEqual(pack.cards!.map(c => c.title));
    expect(rows.map(r => r.position)).toEqual(rows.map((_, i) => i));
  });

  it("starts the first card in Learn and holds the rest in Backlog, so there is one place to begin", () => {
    expect(rows[0]!.kanban_column).toBe("learn");
    expect(rows.slice(1).every(r => r.kanban_column === "backlog")).toBe(true);
  });

  it("teaches every concept exactly once across the board", () => {
    const taught = rows.flatMap(r => r.concept_ids);
    expect(new Set(taught).size).toBe(taught.length);
    expect(taught.sort()).toEqual(pack.concepts.map(c => qualifiedConceptId(pack.id, c.id)).sort());
  });

  it("builds each checklist from its concepts' key points, ids naming the exact statement", () => {
    const first = rows[0]!;
    const concepts = pack.cards![0]!.conceptIds.map(id => pack.concepts.find(c => c.id === id)!);
    expect(first.learning_points).toEqual(
      concepts.flatMap(c => c.keyPoints.map((k, i) => ({ id: `${c.id}:${i + 1}`, text: k.text }))),
    );
  });

  it("summarises a card with its concepts' outcomes, in the pack's own words", () => {
    const concepts = pack.cards![0]!.conceptIds.map(id => pack.concepts.find(c => c.id === id)!);
    expect(rows[0]!.summary).toBe(concepts.map(c => c.outcome).join(" "));
  });

  it("titles the track with the pack's subject", () => {
    expect(trackTitle).toBe(pack.subject);
  });

  it("gives the same board every time, because no model is involved", () => {
    expect(packTrack(pack)).toEqual(packTrack(pack));
  });

  it("puts the VIF misconception's concept on its own card, where the mastery check will look", () => {
    const card = rows.find(r => r.concept_ids.includes(qualifiedConceptId(pack.id, "collinearity")))!;
    expect(card.concept_ids).toEqual([qualifiedConceptId(pack.id, "collinearity")]);
  });
});

describe("packTrack: a pack without cards", () => {
  it("builds an empty board rather than inventing one; the catalog refuses such a pack first", () => {
    const bare: ReferencePack = { ...pack };
    delete bare.cards;
    expect(packTrack(bare).rows).toEqual([]);
  });
});

describe("qualified concept ids", () => {
  it("round-trips, so a stored id always names its pack", () => {
    const id = qualifiedConceptId("linear-regression", "least_squares");
    expect(id).toBe("linear-regression:least_squares");
    expect(parseQualifiedConceptId(id)).toEqual({ packId: "linear-regression", conceptId: "least_squares" });
  });

  it("rejects an id with no pack or no concept, rather than guessing either", () => {
    for (const bad of ["least_squares", ":least_squares", "linear-regression:", ""]) {
      expect(parseQualifiedConceptId(bad)).toBeNull();
    }
  });
});
