import { describe, it, expect } from "vitest";
import { renderPrompt } from "@/lib/claude/subscription/cliArgs";
import type { CallImage } from "@/lib/claude/imageInput";
import {
  buildCoachCall,
  COACH_ANOTHER_LOOK_TURN,
  COACH_FIRST_LOOK_TURN,
  COACH_SYSTEM_PROMPT,
  coachImageProblem,
  coachTurns,
  imagePreamble,
  type CoachThreadMessage,
} from "./coachPrompt";

const settings = { model: "claude-sonnet-4-6", maxTokens: 1024 };
const image: CallImage = { mediaType: "image/png", base64: "AAAA" };

describe("coachTurns", () => {
  const thread: CoachThreadMessage[] = [
    { role: "user", content: "I picked B because it's cheaper." },
    { role: "assistant", content: "Actually A is right..." },
    { role: "user", content: "Why though?" },
  ];

  it("keeps the thread's order and real roles when the learner spoke last", () => {
    expect(coachTurns(thread)).toEqual(thread);
  });

  it("asks for a first answer when Coach is pressed before any thoughts are written", () => {
    expect(coachTurns([])).toEqual([{ role: "user", content: COACH_FIRST_LOOK_TURN }]);
  });

  it("closes on a learner turn when Coach is pressed again, because Claude refuses to continue its own reply", () => {
    const answered = thread.slice(0, 2);
    expect(coachTurns(answered)).toEqual([...answered, { role: "user", content: COACH_ANOTHER_LOOK_TURN }]);
  });

  it("drops blank rows, because Claude rejects an empty turn and would fail the whole call", () => {
    expect(coachTurns([{ role: "assistant", content: "   " }, { role: "user", content: "Hi" }])).toEqual([
      { role: "user", content: "Hi" },
    ]);
    expect(coachTurns([{ role: "user", content: " " }])).toEqual([{ role: "user", content: COACH_FIRST_LOOK_TURN }]);
  });

  it("always produces something the plan path can write, so no press of the button can crash it", () => {
    for (const case_ of [[], thread, thread.slice(0, 2)]) {
      expect(() => renderPrompt(coachTurns(case_))).not.toThrow();
    }
  });
});

describe("buildCoachCall", () => {
  it("carries the route's model and ceiling, and the Coach's own instructions", () => {
    expect(buildCoachCall(settings, [], [image])).toMatchObject({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: COACH_SYSTEM_PROMPT,
    });
  });

  it("captions a multi-snip bucket as one question and keeps its slices in order", () => {
    const second: CallImage = { mediaType: "image/jpeg", base64: "BBBB" };
    const call = buildCoachCall(settings, [], [image, second]);
    expect(call.imageCaption).toBe(imagePreamble(2));
    expect(call.images).toEqual([image, second]);
  });
});

// The whole point of buckets: two snips of one tall question must not be read
// as two questions, or the Coach answers something the learner never asked.
describe("imagePreamble", () => {
  it("frames several images as ordered slices of a single question", () => {
    const text = imagePreamble(2);
    expect(text).toContain("2 slices");
    expect(text).toContain("single question");
    expect(text).toContain("top to bottom");
  });

  it("stays in the singular for an ordinary one-snip screenshot", () => {
    expect(imagePreamble(1)).not.toContain("slices");
  });

  it("warns the system prompt's reader that extra images continue the same page", () => {
    expect(COACH_SYSTEM_PROMPT).toContain("consecutive slices of ONE");
    expect(COACH_SYSTEM_PROMPT).toContain("never as separate questions");
  });
});

describe("coachImageProblem", () => {
  it("lets a question through when every slice was read", () => {
    expect(coachImageProblem([image, image])).toBeNull();
  });

  it("stops the whole question if one slice failed, rather than answering half of it", () => {
    expect(coachImageProblem([image, "unreadable"])).toMatchObject({ status: 502, outcome: "failed" });
  });

  it("counts an unsendable file as refused, so it doesn't read as the system failing", () => {
    expect(coachImageProblem(["too-large"])).toMatchObject({ status: 413, outcome: "refused" });
    expect(coachImageProblem(["not-an-image"])).toMatchObject({ status: 415, outcome: "refused" });
  });

  it("only offers a retry where a retry could work", () => {
    expect(coachImageProblem(["unreadable"])?.error).toContain("Try again");
    expect(coachImageProblem(["too-large"])?.error).not.toContain("Try again");
    expect(coachImageProblem(["not-an-image"])?.error).not.toContain("Try again");
  });

  it("names the fix for a file that can't be sent, not just the problem", () => {
    expect(coachImageProblem(["too-large"])?.error).toContain("7.5 MB");
    expect(coachImageProblem(["too-large"])?.error).toContain("smaller copy");
  });
});
