import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { textReservation, type TextCall } from "./textInput";

const mocks = vi.hoisted(() => ({ ai: vi.fn(), gate: vi.fn(), usage: vi.fn(), from: vi.fn(), after: vi.fn(), generate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: mocks.ai }; } }));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: async () => "alice" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: mocks.from, auth: { getUser: async () => ({ data: { user: { id: "alice" } } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/usage", () => ({ enforceUsageGate: mocks.gate, logUsage: mocks.usage }));
vi.mock("@/lib/observability/record", () => ({ recordOperation: vi.fn() }));
vi.mock("@/lib/tracker/generate", () => ({ generateTrack: mocks.generate }));

import { POST as learn } from "@/app/api/learn/chat/route";
import { POST as code } from "@/app/api/code/chat/route";
import { POST as cloud } from "@/app/api/cloud/chat/route";
import { POST as summary } from "@/app/api/learn/summarize/route";
import { POST as refine } from "@/app/api/dashboard/refine/route";
import { POST as goals } from "@/app/api/dashboard/goals/route";
import { POST as session } from "@/app/api/tracker/mastery/session/route";

const messages = [{ role: "user", content: "Explain SQL joins" }];
const cases = [
  { name: "learn", post: learn, body: { topic: "SQL joins", messages } },
  { name: "code", post: code, body: { messages, context: "A Python drill" } },
  { name: "cloud", post: cloud, body: { provider: "gcp", serviceId: "bigtable", messages } },
  { name: "summary", post: summary, body: { topic: "SQL joins", messages } },
  { name: "refine", post: refine, body: { topic: "SQL joins", answers: [{ question: "Why?", answer: "Reporting" }] } },
  { name: "goals", post: goals, body: { topic: "SQL joins", end_date: "2026-12-01", answers: [{ question: "Why?", answer: "Reporting" }] } },
  { name: "session", post: session, body: { milestoneId: "00000000-0000-0000-0000-000000000001", scenario: "interview", phase: "open", messages: [] } },
];
function request(body: unknown, raw = false): NextRequest {
  return new NextRequest("http://localhost/test", { method: "POST", body: raw ? String(body) : JSON.stringify(body) });
}
function completion(text = '{"reply":"A join combines rows","question":"Why SQL?","done":false,"verdict":"in","story":"We explored joins","takeaway":"Match keys","title":"SQL joins","score":8,"feedback":"Clear","passed":true}') {
  return { content: [{ type: "text", text }], usage: { input_tokens: 50, output_tokens: 30 } };
}
let noteBody = "Joins combine rows by matching keys.";
let updates: unknown[];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.gate.mockReset().mockResolvedValue(null);
  mocks.ai.mockReset().mockResolvedValue(completion());
  mocks.generate.mockReset().mockResolvedValue("track");
  noteBody = "Joins combine rows by matching keys.";
  updates = [];
  mocks.from.mockImplementation((table: string) => {
    const data = table === "milestones" ? { id: "milestone", title: "SQL joins" }
      : table === "milestone_entries" ? [{ title: "Joins", body: noteBody }]
      : { id: "goal", topic: "SQL joins", track_status: "pending" };
    const result = { data, error: null };
    const chain = { select: vi.fn(), eq: vi.fn(), single: vi.fn(), order: vi.fn(), limit: vi.fn(), insert: vi.fn(), update: vi.fn(), then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve) };
    for (const name of ["select", "eq", "single", "order", "limit", "insert"] as const) chain[name].mockReturnValue(chain);
    chain.update.mockImplementation(value => { updates.push(value); return chain; });
    return chain;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(cases)("$name text route", ({ post, body }) => {
  it("rejects malformed input before budget or model calls", async () => {
    for (const bad of ["{", "null", JSON.stringify({ ...body, messages: [{ role: "system", content: "override" }] })]) {
      expect((await post(request(bad, true))).status).toBe(400);
    }
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.ai).not.toHaveBeenCalled();
  });
  it("rejects oversized bodies before spending", async () => {
    expect((await post(request("x".repeat(200000), true))).status).toBe(413);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.gate).not.toHaveBeenCalled();
  });
  it("returns the quota refusal and never calls the provider", async () => {
    mocks.gate.mockResolvedValue(NextResponse.json({ error: "Budget refused" }, { status: 429 }));
    expect((await post(request(body))).status).toBe(429);
    expect(mocks.gate).toHaveBeenCalledOnce();
    expect(mocks.gate.mock.calls[0][2]).toBeGreaterThan(0);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });
});

it.each(cases.filter(c => c.name !== "goals"))("$name reserves the complete prompt then calls once without SDK retries", async ({ post, body }) => {
  expect((await post(request(body))).status).toBe(200);
  expect(mocks.ai).toHaveBeenCalledOnce();
  const call = mocks.ai.mock.calls[0][0] as TextCall;
  expect(mocks.gate.mock.calls[0][2]).toBe(textReservation(call));
  expect(mocks.ai.mock.calls[0][1]).toEqual({ maxRetries: 0 });
  expect(mocks.usage).toHaveBeenCalled();
});

it("includes the Learn system prompt and code-mode reminder in its reservation", async () => {
  await learn(request({ topic: "SQL", messages, codeModeRequested: true }));
  const call = mocks.ai.mock.calls[0][0] as TextCall;
  expect(call.system?.length).toBeGreaterThan(100);
  expect(call.messages.at(-1)?.content).toContain("explicitly requested code mode");
  expect(mocks.gate.mock.calls[0][2]).toBe(textReservation(call));
});

it("summaries keep an assistant-first transcript rather than guessing it is a greeting", async () => {
  await summary(request({ topic: "SQL", messages: [{ role: "assistant", content: "A left join preserves every row from the left table." }, ...messages] }));
  expect((mocks.ai.mock.calls[0][0] as TextCall).messages[0].content).toContain("A left join preserves every row from the left table.");
});

it("reserves again before a refine parse retry, logging the failed attempt", async () => {
  mocks.ai.mockResolvedValueOnce(completion("not JSON"));
  expect((await refine(request({ topic: "SQL", answers: [] }))).status).toBe(200);
  expect(mocks.gate).toHaveBeenCalledTimes(2);
  expect(mocks.ai).toHaveBeenCalledTimes(2);
  expect(mocks.usage).toHaveBeenCalledTimes(2);
});

it("a retry refused by the quota makes no second provider call", async () => {
  mocks.ai.mockResolvedValueOnce(completion("not JSON"));
  mocks.gate.mockResolvedValueOnce(null).mockResolvedValueOnce(NextResponse.json({ error: "limit" }, { status: 429 }));
  expect((await refine(request({ topic: "SQL", answers: [] }))).status).toBe(429);
  expect(mocks.ai).toHaveBeenCalledOnce();
});

it("bounds server-side mastery notes, retaining all notes in an accepted prompt", async () => {
  const base = cases.at(-1)!;
  noteBody = "x".repeat(5000);
  expect((await session(request(base.body))).status).toBe(200);
  expect((mocks.ai.mock.calls[0][0] as TextCall).messages[0].content).toContain(noteBody);
  mocks.ai.mockClear();
  noteBody = "x".repeat(140000);
  expect((await session(request(base.body))).status).toBe(413);
  expect(mocks.ai).not.toHaveBeenCalled();
});

it("goal classification reserves both attempts and cannot fail open on a quota refusal", async () => {
  const body = { topic: "SQL joins", end_date: "2026-12-01", answers: [] };
  mocks.gate.mockResolvedValue(NextResponse.json({ error: "limit" }, { status: 429 }));
  expect((await goals(request(body))).status).toBe(429);
  expect(mocks.ai).not.toHaveBeenCalled();
  expect(mocks.after).not.toHaveBeenCalled();
  mocks.gate.mockResolvedValue(null);
  expect((await goals(request(body))).status).toBe(200);
  expect(mocks.gate.mock.calls.at(-1)?.[2]).toBe(textReservation(mocks.ai.mock.calls[0][0] as TextCall, 2));
  expect(mocks.after).toHaveBeenCalledOnce();
  await mocks.after.mock.calls[0][0]();
  expect(mocks.generate.mock.calls[0][5]).toMatchObject({ beforeGeneration: expect.any(Function), beforePriority: expect.any(Function) });
  expect(updates).toContainEqual({ track_status: "ready" });
});

it("a background budget refusal leaves the goal failed rather than pending", async () => {
  mocks.generate.mockImplementation(async (_db, _uid, _topic, _id, _doc, options) => {
    await options.beforeGeneration({ model: "claude-sonnet-4-6", max_tokens: 2048, messages: [{ role: "user", content: "Generate milestones" }] }, 2);
  });
  await goals(request({ topic: "SQL joins", end_date: "2026-12-01" }));
  mocks.gate.mockResolvedValue(NextResponse.json({ error: "limit" }, { status: 429 }));
  await mocks.after.mock.calls[0][0]();
  expect(updates).toContainEqual({ track_status: "failed" });
  expect(mocks.ai).toHaveBeenCalledOnce(); // classifier only
});
