import { describe, expect, it } from "vitest";
import { defaultAskCard, type AskCard } from "./askFocus";

const card = (id: string, position: number, kanban_column = "backlog"): AskCard =>
  ({ id, title: id, kanban_column, position });

describe("defaultAskCard - where Ask starts when no card is picked", () => {
  it("starts at the first card in board order, not the order the rows arrived in", () => {
    expect(defaultAskCard([card("c", 3), card("a", 1), card("b", 2)])?.id).toBe("a");
  });

  it("skips cards already mastered, so Ask opens where the learner still has work", () => {
    expect(defaultAskCard([card("a", 1, "done"), card("b", 2, "learn"), card("c", 3)])?.id).toBe("b");
  });

  it("falls back to the first card when every card is mastered, rather than none", () => {
    expect(defaultAskCard([card("b", 2, "done"), card("a", 1, "done")])?.id).toBe("a");
  });

  it("returns nothing for a board with no cards, so the page can say so instead of a chat", () => {
    expect(defaultAskCard([])).toBeNull();
  });
});
