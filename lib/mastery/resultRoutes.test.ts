// The routes that record review and mastery results, exercised through their
// real handlers. Two separate fake clients stand in for the learner's own
// session and the service role, so each test can assert WHICH one wrote:
// since migration 058 a learner's session must never write a result.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Result = { data: unknown; error: { message: string } | null };

const mocks = vi.hoisted(() => ({
  userDb:    { from: vi.fn() },
  serviceDb: { from: vi.fn() },
  ai:        vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: async () => "alice" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.userDb }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => mocks.serviceDb }));
vi.mock("@/lib/usage", () => ({ logUsage: vi.fn() }));
vi.mock("@/lib/observability/record", () => ({ recordOperation: vi.fn() }));
vi.mock("@/lib/claude/prompts", () => ({ stripEmphasis: (s: string) => s }));
vi.mock("@/lib/claude/textRequest", () => ({
  readTextRequest: async (req: NextRequest) => ({ body: await req.json() }),
}));
vi.mock("@/lib/claude/textBudget", () => ({
  createTextMessage: mocks.ai,
  textBudgetResponse: () => null,
}));

import { PATCH } from "@/app/api/tracker/milestones/[id]/route";
import { POST as session } from "@/app/api/tracker/mastery/session/route";
import { recordOperation } from "@/lib/observability/record";

let userReplies: Result[];
let serviceReplies: Result[];
const userUpdate = vi.fn();
const serviceUpdate = vi.fn();
const reply = (data: unknown): Result => ({ data, error: null });
const failure = (message: string): Result => ({ data: null, error: { message } });

function fakeClient(replies: () => Result[], update: ReturnType<typeof vi.fn>) {
  const next = () => {
    const r = replies().shift();
    if (!r) throw new Error("Unexpected database query");
    return Promise.resolve(r);
  };
  const chain = {
    select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
    maybeSingle: next, single: next,
    then: (resolve: (r: Result) => unknown) => next().then(resolve),
    update,
  };
  update.mockReturnValue(chain);
  return chain;
}

const owned = (over: Record<string, unknown> = {}) =>
  reply({ id: "card", title: "Collinearity", mastery_validated: false, tracks: { user_id: "alice" }, ...over });
const notMine = reply({ id: "card", title: "Collinearity", mastery_validated: false, tracks: { user_id: "bob" } });

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/tracker/milestones/card", {
      method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "card" }) },
  );
}

function evaluate() {
  return session(new NextRequest("http://localhost/api/tracker/mastery/session", {
    method: "POST",
    body: JSON.stringify({
      milestoneId: "card", scenario: "interview", phase: "evaluate",
      messages: [{ role: "hugh", text: "Explain it." }, { role: "learner", text: "It inflates variance." }],
    }),
    headers: { "Content-Type": "application/json" },
  }));
}

/** The evaluator's reply, as Sonnet would send it. */
function scored(json: object) {
  mocks.ai.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(json) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  userReplies = [];
  serviceReplies = [];
  mocks.userDb.from.mockReturnValue(fakeClient(() => userReplies, userUpdate));
  mocks.serviceDb.from.mockReturnValue(fakeClient(() => serviceReplies, serviceUpdate));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("milestone PATCH: results are not the browser's to write", () => {
  it("refuses a mastery result before touching the database", async () => {
    const res = await patch({ masteryValidated: true, masteryScore: 10 });
    expect(res.status).toBe(400);
    expect(mocks.userDb.from).not.toHaveBeenCalled();
    expect(mocks.serviceDb.from).not.toHaveBeenCalled();
  });

  it("refuses another learner's card even though the write would bypass RLS", async () => {
    userReplies.push(notMine);
    expect((await patch({ column: "learn" })).status).toBe(404);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("reports a failed lookup as an error, not as a missing card", async () => {
    userReplies.push(failure("connection reset"));
    expect((await patch({ column: "learn" })).status).toBe(500);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("writes a move with the service role, never with the learner's own session", async () => {
    userReplies.push(owned());
    serviceReplies.push(reply(null));
    expect((await patch({ column: "done" })).status).toBe(200);
    expect(serviceUpdate).toHaveBeenCalledWith({ kanban_column: "done", mastery_validated: false });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("still records a review pass reported by the quiz, until the quiz is graded on the server", async () => {
    userReplies.push(owned());
    serviceReplies.push(reply(null));
    expect((await patch({ reviewValidated: true })).status).toBe(200);
    expect(serviceUpdate).toHaveBeenCalledWith({ review_validated: true });
  });
});

describe("mastery session evaluate: the server records the result it scored", () => {
  it("validates a first pass and records the score and feedback itself", async () => {
    userReplies.push(owned(), reply([{ title: "Note", body: "VIF measures inflation." }]));
    serviceReplies.push(reply(null));
    scored({ score: 8, feedback: "Clear.", passed: true });
    const res = await evaluate();
    expect(await res.json()).toEqual({ score: 8, feedback: "Clear.", passed: true, record: "saved" });
    expect(serviceUpdate).toHaveBeenCalledWith({ mastery_validated: true, mastery_score: 8, mastery_feedback: "Clear." });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("decides pass or fail from the score, not the model's own flag", async () => {
    userReplies.push(owned(), reply([{ title: "Note", body: "x" }]));
    scored({ score: 5, feedback: "Thin.", passed: true });
    expect(await (await evaluate()).json()).toEqual({ score: 5, feedback: "Thin.", passed: false, record: "skipped" });
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("logs a practice run on a mastered card without touching the validated flag", async () => {
    userReplies.push(owned({ mastery_validated: true }), reply([{ title: "Note", body: "x" }]));
    serviceReplies.push(reply(null));
    scored({ score: 4, feedback: "Rusty.", passed: false });
    await evaluate();
    expect(serviceUpdate).toHaveBeenCalledWith({ mastery_score: 4, mastery_feedback: "Rusty." });
  });

  it("reports a scored session it could not save, so the page can say so", async () => {
    userReplies.push(owned(), reply([{ title: "Note", body: "x" }]));
    serviceReplies.push(failure("permission denied"));
    scored({ score: 9, feedback: "Sharp.", passed: true });
    const res = await evaluate();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ score: 9, feedback: "Sharp.", passed: true, record: "failed" });
    expect(recordOperation).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("records nothing when the evaluator returns an impossible score", async () => {
    userReplies.push(owned(), reply([{ title: "Note", body: "x" }]));
    scored({ score: 11, feedback: "Wow.", passed: true });
    expect((await evaluate()).status).toBe(500);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("refuses another learner's card before spending on the evaluator", async () => {
    userReplies.push(notMine);
    expect((await evaluate()).status).toBe(404);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(serviceUpdate).not.toHaveBeenCalled();
  });
});
