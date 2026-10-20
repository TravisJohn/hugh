import { describe, it, expect } from "vitest";
import {
  buildCriteria,
  renderCriteriaForPrompt,
  prepareDiaryContext,
  MASTERY_RUBRIC,
  PASS_THRESHOLD,
} from "./criteria";

describe("buildCriteria", () => {
  it("builds authoritative concepts from the card's learning points", () => {
    const c = buildCriteria({
      title: "BigQuery partitioning",
      summary: "Partition large tables by date to prune scans.",
      learningPoints: [
        { id: "1", text: "Partitioning prunes scanned data" },
        { id: "2", text: "Clustering orders within partitions" },
        { id: "3", text: "  " }, // blank → dropped
      ],
    });
    expect(c.concepts).toEqual([
      "Partitioning prunes scanned data",
      "Clustering orders within partitions",
    ]);
    expect(c.summary).toContain("prune scans");
    expect(c.passThreshold).toBe(PASS_THRESHOLD);
    expect(c.rubric).toBe(MASTERY_RUBRIC);
  });

  it("tolerates a card with no learning points", () => {
    const c = buildCriteria({ title: "T", summary: null, learningPoints: null });
    expect(c.concepts).toEqual([]);
    expect(c.summary).toBe("");
  });
});

describe("renderCriteriaForPrompt", () => {
  it("embeds concepts, summary, and the rubric verbatim", () => {
    const c = buildCriteria({
      title: "BigQuery partitioning",
      summary: "Prune by date.",
      learningPoints: [{ id: "1", text: "Partition pruning" }],
    });
    const out = renderCriteriaForPrompt(c);
    expect(out).toContain("BigQuery partitioning");
    expect(out).toContain("Partition pruning");
    expect(out).toContain("Prune by date.");
    expect(out).toContain("Apply it to a new, unseen scenario");
    expect(out).toMatch(/authoritative/i);
  });

  it("still asks to assess when there are no learning points", () => {
    const c = buildCriteria({ title: "T", summary: "", learningPoints: [] });
    expect(renderCriteriaForPrompt(c)).toMatch(/general understanding/i);
  });
});

describe("prepareDiaryContext", () => {
  it("caps length and marks truncation", () => {
    const long = "x".repeat(5000);
    const out = prepareDiaryContext([{ title: "n", body: long }], 100);
    expect(out.length).toBeLessThan(200);
    expect(out).toMatch(/truncated/);
  });

  it("returns empty string for no usable entries", () => {
    expect(prepareDiaryContext([], 100)).toBe("");
    expect(prepareDiaryContext([{ body: "   " }], 100)).toBe("");
  });
});

describe("buildCriteria on a course card (narrow Learn, PRD row 4)", () => {
  const syllabus = {
    keyPoints: ["Collinear predictors inflate the variance of their coefficient estimates.", "VIF measures that inflation."],
    misconceptions: [{ ref: "collinearity:m1", claim: "VIF removes multicollinearity.", correction: "VIF only measures it." }],
  };

  it("judges a course card against its source-checked key points, never its learner-editable learning points", () => {
    const criteria = buildCriteria(
      { title: "Multicollinearity", learningPoints: [{ id: "p1", text: "Anything the learner typed here" }] },
      syllabus,
    );
    expect(criteria.concepts).toEqual(syllabus.keyPoints);
    expect(criteria.concepts.join(" ")).not.toContain("Anything the learner typed here");
  });

  it("carries the card's wrong beliefs into the prompt, with what a held one means", () => {
    const text = renderCriteriaForPrompt(buildCriteria({ title: "Multicollinearity" }, syllabus));
    expect(text).toContain("[collinearity:m1] VIF removes multicollinearity.");
    expect(text).toContain("Correction: VIF only measures it.");
    expect(text).toMatch(/does not correct it, they have not mastered this card/);
  });

  it("leaves every other card exactly as before: learning points, and no misconceptions", () => {
    const criteria = buildCriteria({ title: "SQL joins", learningPoints: [{ id: "p1", text: "Inner joins keep matches" }] });
    expect(criteria.concepts).toEqual(["Inner joins keep matches"]);
    expect(criteria.misconceptions).toEqual([]);
    expect(renderCriteriaForPrompt(criteria)).not.toContain("Known wrong beliefs");
  });
});
