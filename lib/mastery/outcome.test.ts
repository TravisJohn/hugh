import { describe, it, expect } from "vitest";
import { masteryOutcome } from "./outcome";

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
  it("fails the card whatever the score, so a confident wrong belief cannot pass", () => {
    expect(masteryOutcome({ score: 9, feedback: "Fluent.", misconceptionsHeld: ["collinearity:m1"] }, false)).toEqual({ passed: false, write: null });
  });

  it("passes a high score when no wrong belief was left standing", () => {
    expect(masteryOutcome({ score: 8, feedback: "Clear.", misconceptionsHeld: [] }, false).passed).toBe(true);
  });

  it("never revokes a card already mastered, but still records the run", () => {
    expect(masteryOutcome({ score: 9, feedback: "Slipped.", misconceptionsHeld: ["collinearity:m2"] }, true)).toEqual({
      passed: false, write: { mastery_score: 9, mastery_feedback: "Slipped." },
    });
  });
});
