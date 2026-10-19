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
