import { describe, it, expect } from "vitest";
import { CURIOSITY_SLIDES, visibleSlides } from "./curiositySlides";
import { catalogIds } from "./catalog";

describe("the curiosity carousel", () => {
  it("points every slide that has a course at a real catalog course", () => {
    const named = CURIOSITY_SLIDES.flatMap(s => (s.packId ? [s.packId] : []));
    expect(named.filter(id => !catalogIds().includes(id))).toEqual([]);
  });

  it("shows the seven slides whose courses exist today, in carousel order", () => {
    expect(visibleSlides(catalogIds()).map(s => s.topic)).toEqual([
      "Clustering", "Outlier detection", "Time series forecasting", "A/B testing",
      "Neural networks", "Bayesian inference", "Decision trees",
    ]);
  });

  it("hides a slide whose course can't be started, so it never offers a subject Hugh doesn't teach", () => {
    expect(visibleSlides(["clustering"]).map(s => s.packId)).toEqual(["clustering"]);
    expect(visibleSlides([])).toEqual([]);
  });

  it("gives every slide its own artwork, so filtering can't pair a slide with the wrong picture", () => {
    const graphics = CURIOSITY_SLIDES.map(s => s.graphic);
    expect(new Set(graphics).size).toBe(graphics.length);
  });
});
