import { describe, expect, it } from "vitest";
import { MIC_PROBLEM_MESSAGE, micProblemFor } from "./micProblem";

describe("micProblemFor", () => {
  it("treats silence and our own stop as normal, so a quiet learner sees no error", () => {
    expect(micProblemFor("no-speech")).toBeNull();
    expect(micProblemFor("aborted")).toBeNull();
  });

  it("tells a blocked mic apart from a missing one, because the fixes differ", () => {
    expect(micProblemFor("not-allowed")).toBe("blocked");
    expect(micProblemFor("service-not-allowed")).toBe("blocked");
    expect(micProblemFor("audio-capture")).toBe("no-mic");
  });

  it("reports a speech service failure, the one that needs the network", () => {
    expect(micProblemFor("network")).toBe("no-service");
  });

  it("never lets an unknown code pass for listening", () => {
    expect(micProblemFor("a-code-from-a-future-browser")).toBe("no-service");
  });
});

describe("MIC_PROBLEM_MESSAGE", () => {
  it("tells the learner to try again in every case, since the screen offers a retry", () => {
    for (const message of Object.values(MIC_PROBLEM_MESSAGE)) {
      expect(message).toMatch(/try again\.$/);
    }
  });
});
