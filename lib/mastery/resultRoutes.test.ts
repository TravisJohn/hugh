// The routes that record review and mastery results, exercised through their
// real handlers. Two separate fake clients stand in for the learner's own
// session and the service role, so each test can assert WHICH one wrote:
// since migration 058 a learner's session must never write a result.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Result = { data: unknown; error: { message: string; code?: string } | null };

const mocks = vi.hoisted(() => ({
  userDb:    { from: vi.fn() },
  serviceDb: { from: vi.fn() },
  ai:        vi.fn(),
  claude:    vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: async () => "alice" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.userDb }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => mocks.serviceDb }));
vi.mock("@/lib/usage", () => ({ logUsage: vi.fn(), checkUsageAllowed: async () => ({ allowed: true }) }));
// The review quiz route calls the SDK directly rather than through textBudget.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { messages = { create: mocks.claude }; },
}));
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
import { POST as quizRoute } from "@/app/api/tracker/review/quiz/route";
import { POST as answerRoute } from "@/app/api/tracker/review/answer/route";
import { POST as submitRoute } from "@/app/api/tracker/review/submit/route";
import { recordOperation } from "@/lib/observability/record";
import { logUsage } from "@/lib/usage";

let userReplies: Result[];
let serviceReplies: Result[];
const userUpdate = vi.fn();
const serviceUpdate = vi.fn();
const userInsert = vi.fn();
const serviceInsert = vi.fn();
const reply = (data: unknown): Result => ({ data, error: null });
const failure = (message: string, code?: string): Result => ({ data: null, error: { message, code } });

function fakeClient(replies: () => Result[], update: ReturnType<typeof vi.fn>, insert: ReturnType<typeof vi.fn>) {
  const next = () => {
    const r = replies().shift();
    if (!r) throw new Error("Unexpected database query");
    return Promise.resolve(r);
  };
  const chain = {
    select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
    is: () => chain, returns: () => chain,
    maybeSingle: next, single: next,
    then: (resolve: (r: Result) => unknown) => next().then(resolve),
    update, insert,
  };
  update.mockReturnValue(chain);
  insert.mockReturnValue(chain);
  return chain;
}

const owned = (over: Record<string, unknown> = {}) =>
  reply({ id: "card", concept_ids: ["linear-regression:collinearity"], title: "Collinearity", mastery_validated: false, tracks: { user_id: "alice" }, ...over });
const notMine = reply({ id: "card", concept_ids: ["linear-regression:collinearity"], title: "Collinearity", mastery_validated: false, tracks: { user_id: "bob" } });

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

/**
 * The evaluator's reply, as Sonnet would send it for a course card: it also
 * lists the syllabus misconceptions the learner held, here none.
 */
function scored(json: object) {
  mocks.ai.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify({ misconceptionsHeld: [], ...json }) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  userReplies = [];
  serviceReplies = [];
  mocks.userDb.from.mockReturnValue(fakeClient(() => userReplies, userUpdate, userInsert));
  mocks.serviceDb.from.mockReturnValue(fakeClient(() => serviceReplies, serviceUpdate, serviceInsert));
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

  it("refuses a review pass before touching the database — only the graded quiz records one", async () => {
    const res = await patch({ reviewValidated: true });
    expect(res.status).toBe(400);
    expect(mocks.userDb.from).not.toHaveBeenCalled();
    expect(mocks.serviceDb.from).not.toHaveBeenCalled();
  });
});

// ── Review quiz ──────────────────────────────────────────────────────────────
const QZ   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARD = "11111111-1111-4111-8111-111111111111";
const NOTE = "Variance inflation factor measures how much collinearity inflates a coefficient's variance. " +
             "A VIF above ten is usually read as a warning sign worth investigating.";
const STORED = [
  // The card is a course card (narrow Learn PR D refuses any other), so each
  // question names the key point it tests: `concept:n` on linear-regression's
  // collinearity concept. The route discards a question that names none.
  { question: "What does VIF measure?", options: ["Bias", "Variance inflation", "Fit", "Skew"], correctIndex: 1,
    explanation: "It measures inflation.", source: "measures how much collinearity inflates", keyPoint: "collinearity:1" },
  { question: "Which VIF is a warning?", options: ["1", "2", "5", "Above ten"], correctIndex: 3,
    explanation: "Above ten is the warning.", source: "A VIF above ten is usually read as a warning", keyPoint: "collinearity:2" },
];
const quizRow = (over: Record<string, unknown> = {}) =>
  reply({ id: QZ, user_id: "alice", milestone_id: CARD, questions: STORED, ...over });

function post(route: (req: NextRequest) => Promise<Response>, path: string, body: unknown) {
  return route(new NextRequest(`http://localhost/api/tracker/review/${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  }));
}

describe("review quiz generation: the answer key stays on the server", () => {
  beforeEach(() => {
    mocks.claude.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(STORED) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });

  it("stores the quiz with its key using the service role, and sends the browser only the questions", async () => {
    userReplies.push(owned({ id: CARD }), reply([{ title: "VIF", body: NOTE }]));
    serviceReplies.push(reply({ id: QZ }));
    const res = await post(quizRoute, "quiz", { milestoneId: CARD });
    const json = await res.json();
    expect(json).toEqual({ quizId: QZ, questions: STORED.map(({ question, options }) => ({ question, options })) });
    expect(JSON.stringify(json)).not.toMatch(/correctIndex|explanation|source/);
    expect(serviceInsert).toHaveBeenCalledWith({ user_id: "alice", milestone_id: CARD, questions: STORED });
    expect(userInsert).not.toHaveBeenCalled();
  });

  it("fails the request if the quiz cannot be stored — a quiz nobody can grade is worse than none", async () => {
    userReplies.push(owned({ id: CARD }), reply([{ title: "VIF", body: NOTE }]));
    serviceReplies.push(failure("permission denied"));
    const res = await post(quizRoute, "quiz", { milestoneId: CARD });
    expect(res.status).toBe(500);
    expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-4-6", feature: "review/quiz" }));
  });

  it("reports a failed diary read as an error, not as a card with no notes", async () => {
    userReplies.push(owned({ id: CARD }), failure("connection reset"));
    expect((await post(quizRoute, "quiz", { milestoneId: CARD })).status).toBe(500);
    expect(mocks.claude).not.toHaveBeenCalled();
  });
});

describe("review answer: an answer is locked before its key is revealed", () => {
  it("locks the answer with the service role, then reveals that question only", async () => {
    serviceReplies.push(quizRow(), reply(null));
    const res = await post(answerRoute, "answer", { quizId: QZ, questionIndex: 1, choice: 3 });
    expect(await res.json()).toEqual({
      questionIndex: 1, choice: 3, correct: true, correctIndex: 3,
      explanation: "Above ten is the warning.", source: "A VIF above ten is usually read as a warning",
    });
    expect(serviceInsert).toHaveBeenCalledWith({ quiz_id: QZ, question_index: 1, choice: 3 });
    expect(mocks.userDb.from).not.toHaveBeenCalled();
  });

  it("reveals against the first locked answer when the question is answered again", async () => {
    serviceReplies.push(quizRow(), failure("duplicate key", "23505"), reply({ choice: 0 }));
    const res = await post(answerRoute, "answer", { quizId: QZ, questionIndex: 1, choice: 3 });
    expect(await res.json()).toMatchObject({ choice: 0, correct: false, correctIndex: 3 });
  });

  it("refuses another learner's quiz without locking or revealing anything", async () => {
    serviceReplies.push(quizRow({ user_id: "bob" }));
    expect((await post(answerRoute, "answer", { quizId: QZ, questionIndex: 0, choice: 1 })).status).toBe(404);
    expect(serviceInsert).not.toHaveBeenCalled();
  });

  it("refuses a question the quiz does not have", async () => {
    serviceReplies.push(quizRow());
    expect((await post(answerRoute, "answer", { quizId: QZ, questionIndex: 2, choice: 1 })).status).toBe(400);
    expect(serviceInsert).not.toHaveBeenCalled();
  });

  it("reports a failed lock as an error rather than revealing the key anyway", async () => {
    serviceReplies.push(quizRow(), failure("connection reset"));
    const res = await post(answerRoute, "answer", { quizId: QZ, questionIndex: 0, choice: 1 });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/correctIndex/);
  });

  it("reports a failed quiz lookup as an error, not as a missing quiz", async () => {
    serviceReplies.push(failure("connection reset"));
    expect((await post(answerRoute, "answer", { quizId: QZ, questionIndex: 0, choice: 1 })).status).toBe(500);
  });
});

describe("review submit: the server grades and records the pass", () => {
  const locked = (...choices: (number | null)[]) =>
    reply(choices.map((choice, question_index) => ({ question_index, choice })));

  it("records a pass with the service role, never with the learner's own session", async () => {
    serviceReplies.push(quizRow(), locked(1, 3), reply(null));
    const res = await post(submitRoute, "submit", { quizId: QZ, milestoneId: CARD });
    expect(await res.json()).toEqual({ total: 2, correct: 2, passed: true, record: "saved" });
    expect(serviceUpdate).toHaveBeenCalledWith({ review_validated: true });
    expect(mocks.userDb.from).not.toHaveBeenCalled();
  });

  it("records nothing when one answer is wrong", async () => {
    serviceReplies.push(quizRow(), locked(1, 2));
    expect(await (await post(submitRoute, "submit", { quizId: QZ, milestoneId: CARD })).json())
      .toEqual({ total: 2, correct: 1, passed: false, record: "skipped" });
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("does not pass a quiz submitted before every question was answered", async () => {
    serviceReplies.push(quizRow(), locked(1));
    expect(await (await post(submitRoute, "submit", { quizId: QZ, milestoneId: CARD })).json())
      .toMatchObject({ passed: false, record: "skipped" });
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("reports a pass it could not save, so the page can offer to save it again", async () => {
    serviceReplies.push(quizRow(), locked(1, 3), failure("permission denied"));
    const res = await post(submitRoute, "submit", { quizId: QZ, milestoneId: CARD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 2, correct: 2, passed: true, record: "failed" });
    expect(recordOperation).toHaveBeenCalledWith(expect.objectContaining({ operation: "quiz.submit", outcome: "failed" }));
  });

  it("refuses a quiz submitted against a card it was not generated for", async () => {
    serviceReplies.push(quizRow({ milestone_id: "22222222-2222-4222-8222-222222222222" }));
    expect((await post(submitRoute, "submit", { quizId: QZ, milestoneId: CARD })).status).toBe(404);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("refuses another learner's quiz", async () => {
    serviceReplies.push(quizRow({ user_id: "bob" }));
    expect((await post(submitRoute, "submit", { quizId: QZ, milestoneId: CARD })).status).toBe(404);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("does not grade on a dropped answers read, which would fail a learner who answered everything", async () => {
    serviceReplies.push(quizRow(), failure("connection reset"));
    expect((await post(submitRoute, "submit", { quizId: QZ, milestoneId: CARD })).status).toBe(500);
    expect(serviceUpdate).not.toHaveBeenCalled();
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
