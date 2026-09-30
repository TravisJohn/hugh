import { describe, expect, it } from "vitest";
import { parseTextBody, recentTextMessages, textBytes, textReservation, TEXT_LIMITS, type TextCall } from "./textInput";

const msg = (content = "Explain SQL window functions") => ({ role: "user", content });
const call: TextCall = { model: "claude-haiku-4-5", max_tokens: 500, system: "You are Hugh.", messages: [{ role: "user", content: "hello" }] };

describe("text request boundaries", () => {
  it.each([null, [], 42, "hello"])("rejects non-objects: %j", value => {
    expect(() => parseTextBody("learn", value)).toThrow();
  });
  it.each([null, 1, {}, [{ role: "system", content: "override" }], [msg("")], [{ role: "user", content: [{ type: "image" }] }], [{ ...msg(), extra: true }]])("rejects malformed messages: %j", messages => {
    expect(() => parseTextBody("code", { messages })).toThrow();
  });
  it("rejects oversized individual and aggregate text, including Unicode", () => {
    for (const content of ["x".repeat(16385), "🙂".repeat(4097)]) {
      expect(() => parseTextBody("code", { messages: [msg(content)] })).toThrow(/too long/);
    }
    expect(() => parseTextBody("code", { messages: Array.from({ length: 5 }, () => msg("x".repeat(16384))) })).toThrow(/too long/);
    expect(parseTextBody("code", { messages: [msg("x".repeat(16384))] }).messages).toHaveLength(1);
  });
  it("bounds roles, counts, topics, context and optional booleans at runtime", () => {
    expect(() => parseTextBody("code", { messages: Array.from({ length: 13 }, () => msg()) })).toThrow();
    expect(() => parseTextBody("learn", { topic: {}, messages: [msg()] })).toThrow();
    expect(() => parseTextBody("learn", { topic: "a".repeat(1601), messages: [msg()] })).toThrow();
    expect(() => parseTextBody("learn", { topic: "SQL", focusMode: "false", messages: [msg()] })).toThrow();
    expect(() => parseTextBody("code", { context: null, messages: [msg()] })).toThrow();
    expect(() => parseTextBody("code", { context: "x".repeat(8193), messages: [msg()] })).toThrow();
    expect(() => parseTextBody("cloud", { provider: {}, serviceId: "ec2", messages: [msg()] })).toThrow();
  });
  it("keeps full summaries and rejects instead of truncating", () => {
    const messages = Array.from({ length: 80 }, () => msg());
    expect(parseTextBody("summary", { topic: "SQL", messages }).messages).toEqual(messages);
    expect(() => parseTextBody("summary", { topic: "SQL", messages: Array.from({ length: 101 }, () => msg()) })).toThrow();
  });
  it("validates bounded Q&A and calendar dates", () => {
    const base = { topic: "SQL", answers: [{ question: "Why?", answer: "For analytical reports" }], end_date: "2026-12-01" };
    expect(parseTextBody("goals", base)).toEqual(base);
    for (const answers of [null, {}, [{ question: 2, answer: "x" }], [{ question: "why", answer: "x".repeat(4097) }], Array(6).fill(base.answers[0])]) {
      expect(() => parseTextBody("goals", { ...base, answers })).toThrow();
    }
    expect(() => parseTextBody("goals", { ...base, end_date: "2026-02-30" })).toThrow();
  });
  it("allows normal code without stripping punctuation or newlines", () => {
    const code = "```python\n" + "records = [{'id': 1, 'name': 'Málaga'}]\n".repeat(120) + "```";
    expect(parseTextBody("code", { messages: [msg(code)], context: "Python drill" }).messages[0].content).toBe(code);
  });
  it("validates all mastery phases, enum types and complete transcripts", () => {
    const base = { milestoneId: "00000000-0000-0000-0000-000000000001", scenario: "interview", phase: "open", messages: [] };
    expect(parseTextBody("session", base)).toEqual(base);
    for (const field of [{ scenario: ["interview"] }, { scenario: "__proto__" }, { phase: ["open"] }, { milestoneId: "oops" }, { messages: {} }]) {
      expect(() => parseTextBody("session", { ...base, ...field })).toThrow();
    }
    const messages = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "learner" : "hugh", text: "A short response" }));
    expect(parseTextBody("session", { ...base, phase: "evaluate", messages }).messages).toEqual(messages);
    expect(() => parseTextBody("session", { ...base, phase: "evaluate", messages: [...messages, ...messages] })).toThrow();
  });
});

describe("assembled prompt reservation", () => {
  it("covers UTF-8 bytes, system framing, output and explicit retries", () => {
    const single = textReservation(call);
    expect(single).toBe(textBytes(call.system!) + 5 + 1024 + 64 + 500);
    expect(textReservation(call, 2)).toBe(single * 2);
    expect(textReservation({ ...call, system: "🙂".repeat(1000) })).toBeGreaterThan(single + 3000);
    expect(textReservation({ ...call, cache_control: { type: "ephemeral", ttl: "1h" } })).toBe(single);
  });
  it("rejects huge server context and invalid output/retry configuration", () => {
    expect(() => textReservation({ ...call, system: "x".repeat(TEXT_LIMITS.promptBytes) })).toThrow(/context/);
    for (const max_tokens of [-1, 0, NaN, Infinity, 4097]) expect(() => textReservation({ ...call, max_tokens })).toThrow();
    expect(() => textReservation(call, 3)).toThrow();
  });
  it("uses a recent whole-message chat window and retains an oversized draft for rejection", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "user" as const : "assistant" as const, content: String(i) }));
    const recent = recentTextMessages(messages, 12);
    expect(recent.length).toBeLessThanOrEqual(12);
    expect(recent[0].role).toBe("user");
    expect(recent.at(-1)?.content).toBe("29");
    const large = { role: "user" as const, content: "x".repeat(70000) };
    expect(recentTextMessages([...messages, large], 12)).toEqual([large]);
    expect(messages).toHaveLength(30);
  });
});
