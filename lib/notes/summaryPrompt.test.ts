import { describe, it, expect } from "vitest";
import { buildSummaryPrompt, SUMMARY_SYSTEM_PROMPT, type SummaryThreadMessage } from "./summaryPrompt";

describe("buildSummaryPrompt", () => {
  const thread: SummaryThreadMessage[] = [
    { role: "user", content: "I picked B because it's cheaper." },
    { role: "assistant", content: "Actually A is right — B trades away durability." },
  ];

  it("carries the summary instructions and exactly one user turn", () => {
    const { system, messages } = buildSummaryPrompt(thread);
    expect(system).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("flattens the thread into a Learner/Hugh labelled transcript", () => {
    const text = buildSummaryPrompt(thread).messages[0].content;
    expect(text).toContain("Learner: I picked B because it's cheaper.");
    expect(text).toContain("Hugh: Actually A is right");
    // learner turn comes before Hugh's reply
    expect(text.indexOf("Learner:")).toBeLessThan(text.indexOf("Hugh:"));
  });

  it("handles a single-message thread", () => {
    const { messages } = buildSummaryPrompt([{ role: "user", content: "Only my thoughts." }]);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("Learner: Only my thoughts.");
  });
});
