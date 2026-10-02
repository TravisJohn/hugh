import { describe, it, expect } from "vitest";
import { normalizeVerdict, mayProceed, awaitsChoice, unavailableVerdict } from "./topic-domain";

describe("normalizeVerdict — the three verdicts", () => {
  it("passes a well-formed in-domain verdict through and lets it build a track", () => {
    const v = normalizeVerdict({ verdict: "in", reason: "sql is core data", message: "", suggestions: [] });
    expect(v.verdict).toBe("in");
    expect(mayProceed(v)).toBe(true);
  });

  it("blocks an out-of-domain verdict and keeps its learner-facing message", () => {
    const v = normalizeVerdict({
      verdict: "out",
      reason: "nursing licensure",
      message: "Hugh is built for data & analytics.",
      suggestions: [],
    });
    expect(v.verdict).toBe("out");
    expect(mayProceed(v)).toBe(false);
    expect(v.message).toBe("Hugh is built for data & analytics.");
  });

  it("holds an ambiguous topic at needs_angle rather than rejecting it", () => {
    const v = normalizeVerdict({
      verdict: "needs_angle",
      reason: "generative ai spans engineering and tool use",
      message: "Which angle did you mean?",
      suggestions: ["RAG pipelines and evaluation", "Fine-tuning for data teams"],
    });
    expect(v.verdict).toBe("needs_angle");
    // It blocks the build, but it is NOT a rejection — the UI reads the verdict,
    // not a boolean, to decide which of the two it shows.
    expect(mayProceed(v)).toBe(false);
    expect(v.suggestions).toHaveLength(2);
  });
});

describe("normalizeVerdict — a broken judge asks for a retry", () => {
  it.each([
    ["null",              null],
    ["a bare string",     "out"],
    ["an empty object",   {}],
    ["an unknown verdict", { verdict: "maybe" }],
    ["a number verdict",  { verdict: 3 }],
  ])("does not build a track when the response is %s", (_label, raw) => {
    expect(normalizeVerdict(raw).verdict).toBe("unavailable");
    expect(mayProceed(normalizeVerdict(raw))).toBe(false);
  });

  it("shows a retry message without invented topic suggestions", () => {
    const v = normalizeVerdict({});
    expect(v.message).toContain("try again");
    expect(v.suggestions).toEqual([]);
  });
});

describe("normalizeVerdict — needs_angle must offer a way out", () => {
  it("treats needs_angle without suggestions as unavailable", () => {
    // Blocking with zero suggestions would be a question with no answers —
    // a dead end (CLAUDE.md rule 5). Let it through instead.
    const v = normalizeVerdict({ verdict: "needs_angle", message: "Which one?", suggestions: [] });
    expect(v.verdict).toBe("unavailable");
    expect(v.reason).toBe("needs-angle-without-suggestions");
  });

  it("asks for a retry when the suggestions are present but blank", () => {
    const v = normalizeVerdict({ verdict: "needs_angle", suggestions: ["", "   "] });
    expect(v.verdict).toBe("unavailable");
  });

  it("still blocks an out verdict that offers no suggestions", () => {
    // "out" is a statement, not a question, so it does not need answers to
    // be actionable — the copy alone tells the learner where they stand.
    const v = normalizeVerdict({ verdict: "out", message: "Outside Hugh's focus.", suggestions: [] });
    expect(v.verdict).toBe("out");
  });

  it("caps suggestions at three and drops non-strings", () => {
    const v = normalizeVerdict({
      verdict: "needs_angle",
      suggestions: ["a", "b", "c", "d", 5, null],
    });
    expect(v.suggestions).toEqual(["a", "b", "c"]);
  });
});

describe("normalizeVerdict — tolerates the old boolean shape", () => {
  it("reads a legacy inDomain:false as out", () => {
    const v = normalizeVerdict({ inDomain: false, message: "Outside the focus.", suggestions: ["SQL"] });
    expect(v.verdict).toBe("out");
    expect(v.suggestions).toEqual(["SQL"]);
  });

  it("reads a legacy inDomain:true as in", () => {
    expect(normalizeVerdict({ inDomain: true }).verdict).toBe("in");
  });

  it("prefers an explicit verdict over the legacy boolean", () => {
    const v = normalizeVerdict({ inDomain: false, verdict: "in" });
    expect(v.verdict).toBe("in");
  });
});

describe("unavailableVerdict", () => {
  it("blocks a build and carries a reason for the logs", () => {
    const v = unavailableVerdict();
    expect(mayProceed(v)).toBe(false);
    expect(v.reason).toBe("classifier-unavailable");
  });
});

describe("the retired reframe verdict", () => {
  it("maps a stray 'reframe' to a decline, never to approval", () => {
    // An older prompt, or a model reverting to one, can still emit it. Letting
    // it fall through to the fail-open default would build a track for a
    // subject the judge had just called off-domain.
    const v = normalizeVerdict({
      verdict: "reframe",
      reason:  "language learning",
      message: "I could teach you to measure your retention instead.",
      suggestions: ["Measuring vocabulary retention with spaced-repetition data"],
    });
    expect(v.verdict).toBe("out");
    expect(mayProceed(v)).toBe(false);
  });

  it("drops the angles that came with it, so a decline stays a decline", () => {
    // A decline that offers a data version of the learner's subject reads as a
    // pitch. Hugh says no and stops.
    const v = normalizeVerdict({
      verdict: "reframe", reason: "r", message: "m", suggestions: ["Analysing study logs"],
    });
    expect(v.suggestions).toEqual([]);
    expect(v.message).toBe("");
  });
});

describe("awaitsChoice — so no caller branches on 'out' alone", () => {
  it("is true for the verdict that hands the learner something to pick", () => {
    expect(awaitsChoice(normalizeVerdict({
      verdict: "needs_angle", reason: "", message: "", suggestions: ["Cloud data warehouses"],
    }))).toBe(true);
  });

  it("is false for a decision Hugh has already made in either direction", () => {
    expect(awaitsChoice(unavailableVerdict())).toBe(false);
    expect(awaitsChoice(normalizeVerdict({
      verdict: "out", reason: "", message: "", suggestions: [],
    }))).toBe(false);
  });
});

describe("an approved topic that still has something to say", () => {
  it("keeps a note on an explicit 'in', for a tool Hugh teaches at concept level", () => {
    const v = normalizeVerdict({
      verdict: "in",
      reason:  "orchestration tool",
      message: "I'll teach you the orchestration thinking behind Airflow rather than the UI itself.",
      suggestions: [],
    });
    expect(v.verdict).toBe("in");
    expect(mayProceed(v)).toBe(true);
    expect(v.message).toContain("orchestration thinking");
  });

  it("stays silent for an ordinary concept topic", () => {
    const v = normalizeVerdict({ verdict: "in", reason: "core stats", message: "", suggestions: [] });
    expect(v.message).toBe("");
  });

  it("does not claim to have judged a topic when unavailable", () => {
    expect(unavailableVerdict().message).toContain("couldn't check");
    expect(normalizeVerdict("not an object").message).toContain("couldn't check");
  });

  it("drops any suggestions that arrive with an 'in', which has nothing to offer", () => {
    const v = normalizeVerdict({
      verdict: "in", reason: "", message: "", suggestions: ["Building RAG pipelines"],
    });
    expect(v.suggestions).toEqual([]);
  });
});
