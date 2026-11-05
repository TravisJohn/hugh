import { describe, expect, it } from "vitest";
import { MASTERY_FEEDBACK_MAX_CHARS, MASTERY_PASS_SCORE, MASTERY_SCORE_MAX, MASTERY_SCORE_MIN, masteryOutcome } from "./outcome";
import { cardMisconceptions, cardTopics, coverageFeedback, coverageScore, coverageSummary, topicsForBrowser } from "./topics";

const COURSE_CARD = ["linear-regression:collinearity"];

describe("where a card's topics come from", () => {
  it("takes a course card's topics from its pack, by the same refs the syllabus uses", () => {
    const found = cardTopics(COURSE_CARD, null);
    if (found.kind !== "ok") throw new Error("the collinearity card must ground");
    expect(found.topics.length).toBeGreaterThan(0);
    expect(found.ground).not.toBeNull();
    for (const t of found.topics) {
      expect(t.ref).toMatch(/^[a-z0-9_-]+:\d+$/);
      expect(t.label.length).toBeLessThan(t.point.length);
    }
  });

  it("ignores learning_points on a course card, because a learner can write them", () => {
    const planted = [{ id: "p1", text: "Just this one easy thing" }];
    const found = cardTopics(COURSE_CARD, planted);
    if (found.kind !== "ok") throw new Error("the collinearity card must ground");
    expect(found.topics.map(t => t.label)).not.toContain("Just this one easy thing");
  });

  it("uses an older card's own checklist", () => {
    const found = cardTopics(null, [{ id: "p1", text: "Why joins matter" }, { id: "p2", text: "Inner vs outer" }]);
    if (found.kind !== "ok") throw new Error("an older card with a checklist has topics");
    expect(found.ground).toBeNull();
    expect(found.topics.map(t => t.ref)).toEqual(["p1", "p2"]);
  });

  it("says an older card's list is missing rather than giving it an empty one", () => {
    expect(cardTopics(null, null).kind).toBe("missing");
    expect(cardTopics([], []).kind).toBe("missing");
  });

  it("does not trust the shape of learning_points, which is learner-writable JSON", () => {
    expect(cardTopics(null, "everything").kind).toBe("missing");
    expect(cardTopics(null, [null, { id: 1, text: "x" }, { id: "p1", text: "  " }]).kind).toBe("missing");
    const found = cardTopics(null, [null, { id: "p2", text: "Real one" }]);
    expect(found.kind === "ok" && found.topics.map(t => t.ref)).toEqual(["p2"]);
  });

  it("refuses a course card whose pack is gone, in its own words, rather than judging it ungrounded", () => {
    const found = cardTopics(["linear-regression:no-such-concept"], [{ id: "p1", text: "Fallback" }]);
    expect(found.kind).toBe("refused");
  });
});

describe("what reaches the browser", () => {
  it("sends names only, so the panel holds nothing that can be read out as an answer", () => {
    const found = cardTopics(COURSE_CARD, null);
    if (found.kind !== "ok") throw new Error("the collinearity card must ground");
    const sent = topicsForBrowser(found.topics);
    expect(sent.length).toBe(found.topics.length);
    for (const topic of sent) expect(Object.keys(topic).sort()).toEqual(["label", "ref"]);
    for (const { point } of found.topics) expect(JSON.stringify(sent)).not.toContain(point);
  });
});

describe("wrong beliefs on a card", () => {
  it("lists a course card's, and none on an older card", () => {
    const found = cardTopics(COURSE_CARD, null);
    if (found.kind !== "ok" || !found.ground) throw new Error("the collinearity card must ground");
    expect(cardMisconceptions(found.ground).length).toBeGreaterThan(0);
    expect(cardMisconceptions(null)).toEqual([]);
  });
});

describe("the score is arithmetic on the ticks", () => {
  it.each([
    [7, 10, 7], [6, 9, 6], [7, 9, 7], [3, 4, 7], [2, 3, 6], [3, 3, 10], [11, 15, 7], [10, 15, 6],
  ])("%i of %i topics scores %i", (covered, total, score) => {
    expect(coverageScore(covered, total)).toBe(score);
  });

  it("never falls below the scale's floor, because the column holds 1 to 10", () => {
    expect(coverageScore(0, 9)).toBe(MASTERY_SCORE_MIN);
    expect(coverageScore(0, 0)).toBe(MASTERY_SCORE_MIN);
  });

  it("never exceeds the top of the scale", () => {
    expect(coverageScore(99, 9)).toBe(MASTERY_SCORE_MAX);
  });

  it("passes exactly when at least 70% of topics are covered, on every card size", () => {
    for (let total = 1; total <= 20; total += 1) {
      for (let covered = 0; covered <= total; covered += 1) {
        const passes = coverageScore(covered, total) >= MASTERY_PASS_SCORE;
        expect(passes, `${covered} of ${total}`).toBe(covered * 10 >= total * 7);
      }
    }
  });

  it("fails full coverage that left a wrong belief standing", () => {
    const outcome = masteryOutcome({ score: coverageScore(9, 9), feedback: "x", misconceptionsHeld: ["c:m1"] }, false);
    expect(outcome.passed).toBe(false);
    expect(outcome.write).toBeNull();
  });
});

describe("the feedback is built from the ticks too", () => {
  const topics = [{ ref: "a", label: "Alpha" }, { ref: "b", label: "Beta" }, { ref: "c", label: "Gamma" }];

  it("names what was missed, speaking to the learner", () => {
    expect(coverageFeedback(topics, ["a"])).toBe("You covered 1 of 3 topics. Not covered: Beta; Gamma.");
  });

  it("says when everything was covered, in words that read right for a single topic", () => {
    expect(coverageFeedback(topics, ["a", "b", "c"])).toBe("You covered all 3 topics.");
    expect(coverageFeedback([topics[0]!], ["a"])).toBe("You covered the topic.");
  });

  it("gives the result screen the same facts in parts, since its panel already shows what is open", () => {
    expect(coverageSummary(topics, ["a"])).toEqual({ headline: "You covered 1 of 3 topics.", missed: ["Beta", "Gamma"] });
    expect(coverageSummary(topics, ["a", "b", "c"])).toEqual({ headline: "You covered all 3 topics.", missed: [] });
  });

  it("keeps each correction in what the card stores, so a later summary can draw on it", () => {
    expect(coverageFeedback(topics, ["a", "b", "c"], ["Not yet: one.", "Not yet: two."]))
      .toBe("You covered all 3 topics.\n\nNot yet: one.\n\nNot yet: two.");
  });

  it("stays within what the row is meant to hold", () => {
    const long = Array.from({ length: 50 }, (_, i) => ({ ref: String(i), label: "x".repeat(90) }));
    expect(coverageFeedback(long, []).length).toBeLessThanOrEqual(MASTERY_FEEDBACK_MAX_CHARS);
    // The cap covers the corrections as well, not just the coverage sentence.
    expect(coverageFeedback(topics, [], ["x".repeat(MASTERY_FEEDBACK_MAX_CHARS)]).length).toBe(MASTERY_FEEDBACK_MAX_CHARS);
  });
});
