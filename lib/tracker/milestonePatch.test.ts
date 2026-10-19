import { describe, it, expect } from "vitest";
import { buildMilestonePatch } from "./milestonePatch";

describe("buildMilestonePatch: mastery results", () => {
  it.each([
    ["a validated flag", { masteryValidated: true }],
    ["a score", { masteryScore: 10 }],
    ["feedback", { masteryFeedback: "Perfect." }],
    ["a validated flag riding on a move", { column: "done", masteryValidated: true }],
  ])("refuses %s, because only the mastery session may record a result", (_label, body) => {
    expect(buildMilestonePatch(body)).toEqual({ ok: false, error: "Mastery results cannot be set through this route" });
  });

  it("ignores the false flag older clients sent with a move into done, since the move implies it", () => {
    expect(buildMilestonePatch({ column: "done", masteryValidated: false }))
      .toEqual({ ok: true, write: { kanban_column: "done", mastery_validated: false } });
  });
});

describe("buildMilestonePatch: moving a card", () => {
  it("moves a card into a stage with nothing to reset", () => {
    expect(buildMilestonePatch({ column: "learn" })).toEqual({ ok: true, write: { kanban_column: "learn" } });
  });

  it("clears the review result when a card moves into review, so it must be earned again", () => {
    expect(buildMilestonePatch({ column: "review" }))
      .toEqual({ ok: true, write: { kanban_column: "review", review_validated: false } });
  });

  it("clears the mastery result when a card moves into done, so it must be proven again", () => {
    expect(buildMilestonePatch({ column: "done" }))
      .toEqual({ ok: true, write: { kanban_column: "done", mastery_validated: false } });
  });

  it("accepts the false review flag older clients sent with a move into review", () => {
    expect(buildMilestonePatch({ column: "review", reviewValidated: false }))
      .toEqual({ ok: true, write: { kanban_column: "review", review_validated: false } });
  });

  it("refuses a move that carries a passed review, which would promote a card in one request", () => {
    expect(buildMilestonePatch({ column: "review", reviewValidated: true }))
      .toEqual({ ok: false, error: "A review result cannot be sent with a column move" });
  });

  it("refuses a column the board does not have", () => {
    expect(buildMilestonePatch({ column: "mastered" })).toEqual({ ok: false, error: "Invalid column" });
  });
});

describe("buildMilestonePatch: a review result on its own (interim, until the quiz is graded on the server)", () => {
  it("records a review pass reported by the quiz", () => {
    expect(buildMilestonePatch({ reviewValidated: true })).toEqual({ ok: true, write: { review_validated: true } });
  });

  it("refuses a review result that is not a boolean", () => {
    expect(buildMilestonePatch({ reviewValidated: "yes" })).toEqual({ ok: false, error: "reviewValidated must be true or false" });
  });
});

describe("buildMilestonePatch: malformed requests", () => {
  it.each([[null], [[]], ["column=done"]])("refuses a body that is not an object: %j", body => {
    expect(buildMilestonePatch(body)).toEqual({ ok: false, error: "Invalid request body" });
  });

  it("refuses an empty request instead of writing nothing silently", () => {
    expect(buildMilestonePatch({})).toEqual({ ok: false, error: "No valid fields to update" });
  });
});
