import { describe, it, expect } from "vitest";
import { MASTERY_FEEDBACK_MAX_CHARS, masteryOutcome, parseEvaluation } from "./outcome";

describe("parseEvaluation", () => {
  it("accepts a whole-number score from 1 to 10 with feedback", () => {
    expect(parseEvaluation({ score: 7, feedback: " Clear. ", passed: true })).toEqual({ score: 7, feedback: "Clear." });
  });

  it("ignores the model's own passed flag, so it cannot contradict the score", () => {
    expect(parseEvaluation({ score: 3, feedback: "Thin.", passed: true })).toEqual({ score: 3, feedback: "Thin." });
  });

  it.each([
    ["a fractional score", { score: 7.5, feedback: "x" }],
    ["a score above 10", { score: 11, feedback: "x" }],
    ["a score of 0", { score: 0, feedback: "x" }],
    ["a score sent as text", { score: "8", feedback: "x" }],
    ["missing feedback", { score: 8 }],
    ["blank feedback", { score: 8, feedback: "   " }],
    ["no object at all", null],
  ])("rejects %s rather than recording a made-up result", (_label, raw) => {
    expect(parseEvaluation(raw)).toBeNull();
  });

  it("caps runaway feedback so one bad reply cannot bloat the row", () => {
    const long = parseEvaluation({ score: 8, feedback: "a".repeat(MASTERY_FEEDBACK_MAX_CHARS + 500) });
    expect(long?.feedback).toHaveLength(MASTERY_FEEDBACK_MAX_CHARS);
  });
});

describe("masteryOutcome", () => {
  it("validates a card on a first pass at the threshold, and records the score and feedback", () => {
    expect(masteryOutcome({ score: 7, feedback: "Good." }, false)).toEqual({
      passed: true,
      write: { mastery_validated: true, mastery_score: 7, mastery_feedback: "Good." },
    });
  });

  it("records nothing on a first attempt below the threshold, as before", () => {
    expect(masteryOutcome({ score: 6, feedback: "Close." }, false)).toEqual({ passed: false, write: null });
  });

  it("logs a practice run on a mastered card without touching the validated flag", () => {
    expect(masteryOutcome({ score: 9, feedback: "Sharp." }, true)).toEqual({
      passed: true,
      write: { mastery_score: 9, mastery_feedback: "Sharp." },
    });
  });

  it("records even a lower practice score, and never revokes mastery", () => {
    const out = masteryOutcome({ score: 4, feedback: "Rusty." }, true);
    expect(out.write).toEqual({ mastery_score: 4, mastery_feedback: "Rusty." });
    expect(out.write).not.toHaveProperty("mastery_validated");
  });
});

describe("a held misconception on a course card (narrow Learn, PRD row 4)", () => {
  const known = ["collinearity:m1", "collinearity:m2"];

  it("fails the card whatever the score, so a confident wrong belief cannot pass", () => {
    const evaluation = parseEvaluation({ score: 9, feedback: "Fluent.", misconceptionsHeld: ["collinearity:m1"] }, known)!;
    expect(masteryOutcome(evaluation, false)).toEqual({ passed: false, write: null });
  });

  it("passes a high score when no wrong belief was left standing", () => {
    const evaluation = parseEvaluation({ score: 8, feedback: "Clear.", misconceptionsHeld: [] }, known)!;
    expect(masteryOutcome(evaluation, false).passed).toBe(true);
  });

  it("never revokes a card already mastered, but still records the run", () => {
    const evaluation = parseEvaluation({ score: 9, feedback: "Slipped.", misconceptionsHeld: ["collinearity:m2"] }, known)!;
    expect(masteryOutcome(evaluation, true)).toEqual({ passed: false, write: { mastery_score: 9, mastery_feedback: "Slipped." } });
  });

  it("refuses an evaluation with no list on a course card, rather than reading silence as 'held none'", () => {
    expect(parseEvaluation({ score: 9, feedback: "Fluent." }, known)).toBeNull();
    expect(parseEvaluation({ score: 9, feedback: "Fluent.", misconceptionsHeld: "collinearity:m1" }, known)).toBeNull();
    expect(parseEvaluation({ score: 9, feedback: "Fluent.", misconceptionsHeld: [3] }, known)).toBeNull();
  });

  it("ignores a ref that is not on this card, so nobody fails on a belief the syllabus never listed", () => {
    const evaluation = parseEvaluation({ score: 8, feedback: "Clear.", misconceptionsHeld: ["made_up:m9"] }, known)!;
    expect(evaluation.misconceptionsHeld).toEqual([]);
    expect(masteryOutcome(evaluation, false).passed).toBe(true);
  });

  it("does not ask for the list on any other card", () => {
    expect(parseEvaluation({ score: 8, feedback: "Clear." })).toEqual({ score: 8, feedback: "Clear." });
  });
});
