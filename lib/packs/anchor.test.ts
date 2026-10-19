import { describe, it, expect } from "vitest";
import { ANCHOR_MAX_GAP, findAnchor, normalizeText, textFragmentUrl, wordCount } from "./anchor";

const PAGE =
  "Lesson 12. When two predictors move together, the estimated coefficients become " +
  "unstable and their standard errors grow large. A variance inflation factor measures " +
  "how much the variance is inflated; it does not remove the problem.";

describe("normalizeText", () => {
  it("folds case, whitespace runs, curly quotes and dashes so a hand-typed anchor matches the page", () => {
    expect(normalizeText("  The “model”’s fit — good ")).toBe("the \"model\"'s fit - good");
  });

  it("drops soft hyphens, which pages insert invisibly inside long words", () => {
    expect(normalizeText("multi­collinearity")).toBe("multicollinearity");
  });
});

describe("wordCount", () => {
  it("counts words regardless of surrounding or repeated whitespace", () => {
    expect(wordCount("  two   words ")).toBe(2);
  });
});

describe("findAnchor", () => {
  it("finds a passage whose start and end words are both on the page", () => {
    expect(findAnchor(PAGE, { start: "When two predictors", end: "errors grow large" })).toEqual({ status: "found" });
  });

  it("matches despite case and typographic differences between anchor and page", () => {
    expect(findAnchor(PAGE, { start: "WHEN TWO PREDICTORS", end: "Errors   grow large" })).toEqual({ status: "found" });
  });

  it("reports a missing start, because a passage the source never wrote cannot back a claim", () => {
    expect(findAnchor(PAGE, { start: "VIF removes collinearity", end: "grow large" })).toEqual({ status: "start-missing" });
  });

  it("rejects an ambiguous start, because a reviewer's link could land on the wrong passage", () => {
    expect(findAnchor(PAGE, { start: "the", end: "grow large" })).toEqual({ status: "start-ambiguous", occurrences: 3 });
  });

  it("matches whole words only, so a start cannot hide inside a longer word", () => {
    expect(findAnchor("We breathe models in.", { start: "the model", end: "in" })).toEqual({ status: "start-missing" });
  });

  it("reports a missing end when the end words only appear before the start", () => {
    expect(findAnchor(PAGE, { start: "A variance inflation", end: "When two predictors" })).toEqual({ status: "end-missing" });
  });

  it("reports a missing end when it sits further past the start than the allowed gap", () => {
    const far = "Opening words here. " + "x ".repeat(ANCHOR_MAX_GAP) + "closing words.";
    expect(findAnchor(far, { start: "Opening words here", end: "closing words" })).toEqual({ status: "end-missing" });
  });
});

describe("textFragmentUrl", () => {
  it("builds a link that highlights the passage, escaping the characters fragment syntax reserves", () => {
    expect(textFragmentUrl("https://example.org/lesson#top", { start: "least-squares fit", end: "errors, large" }))
      .toBe("https://example.org/lesson#:~:text=least%2Dsquares%20fit,errors%2C%20large");
  });
});
