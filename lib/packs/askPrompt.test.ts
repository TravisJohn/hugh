import { describe, it, expect } from "vitest";
import { courseAskSystemPrompt, OUTSIDE_SYLLABUS_LABEL } from "./askPrompt";
import { cardGrounding, renderCardSyllabus } from "./grounding";
import { packTrack } from "./track";
import { focusedLearningSystemPrompt } from "@/lib/claude/prompts";
import linearRegression from "@/content/packs/linear-regression.json";
import type { ReferencePack } from "@/types/pack";

const pack = linearRegression as ReferencePack;
const card = packTrack(pack).rows.find(r => r.concept_ids.includes("linear-regression:collinearity"))!;
const g = (() => {
  const result = cardGrounding(card.concept_ids);
  if (result.kind !== "ok") throw new Error("expected ok");
  return result.ground;
})();
const prompt = courseAskSystemPrompt(g, card.title);

describe("courseAskSystemPrompt", () => {
  it("keeps today's tutor prompt whole, so the reply's JSON contract and code mode still hold", () => {
    expect(prompt.startsWith(focusedLearningSystemPrompt(`${g.subject}: ${card.title}`))).toBe(true);
  });

  it("carries the card's syllabus, the same block every other surface is judged against", () => {
    expect(prompt).toContain(renderCardSyllabus(g));
  });

  it("names the course and card itself, rather than a subject the browser chose", () => {
    expect(prompt).toContain(`${g.subject}: ${card.title}`);
  });

  it("tells the tutor the exact label for an answer outside the syllabus (PRD row 3)", () => {
    expect(prompt).toContain(`start "reply" with exactly "${OUTSIDE_SYLLABUS_LABEL}"`);
  });

  it("tells the tutor to correct a listed wrong belief and to point to the card that covers a question", () => {
    expect(prompt).toMatch(/common misconception and give its correction/);
    expect(prompt).toMatch(/That's covered in the card/);
  });

  it("forbids links, because the page shows the card's sources from the pack", () => {
    expect(prompt).toMatch(/Never write links or cite URLs/);
  });

  it("is identical across calls for the same card, so the whole prompt is one cacheable prefix", () => {
    expect(courseAskSystemPrompt(g, card.title)).toBe(prompt);
  });
});
