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
const serviceDelete = vi.fn();
const userDelete = vi.fn();
const reply = (data: unknown): Result => ({ data, error: null });
const failure = (message: string, code?: string): Result => ({ data: null, error: { message, code } });

function fakeClient(replies: () => Result[], update: ReturnType<typeof vi.fn>, insert: ReturnType<typeof vi.fn>, del: ReturnType<typeof vi.fn>) {
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
    update, insert, delete: del,
  };
  update.mockReturnValue(chain);
  insert.mockReturnValue(chain);
  del.mockReturnValue(chain);
  return chain;
}

const CHECKLIST = [
  { id: "p1", text: "What VIF measures" }, { id: "p2", text: "When VIF is too high" },
  { id: "p3", text: "Dropping a predictor" }, { id: "p4", text: "Ridge regression" },
];
const owned = (over: Record<string, unknown> = {}) =>
  reply({ id: "card", title: "Collinearity", mastery_validated: false, concept_ids: null, learning_points: CHECKLIST, tracks: { user_id: "alice" }, ...over });
const notMine = reply({ id: "card", title: "Collinearity", mastery_validated: false, concept_ids: null, learning_points: CHECKLIST, tracks: { user_id: "bob" } });

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/tracker/milestones/card", {
      method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "card" }) },
  );
}

function sessionCall(body: object) {
  return session(new NextRequest("http://localhost/api/tracker/mastery/session", {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  }));
}
const startCall  = () => sessionCall({ phase: "start", milestoneId: "card" });
const turnCall   = (said: string) => sessionCall({ phase: "turn", sessionId: "sess", said, recent: [] });
const finishCall = () => sessionCall({ phase: "finish", sessionId: "sess" });

/** The server's record of a session in progress. */
const heldSession = (over: Record<string, unknown> = {}) => reply({
  id: "sess", milestone_id: "card", topic_refs: ["p1", "p2", "p3", "p4"],
  covered: [], held: [], turns: 1, finished_at: null, ...over,
});

/** The check's reply, as Sonnet would send it. */
function checked(json: object) {
  mocks.ai.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify({ covered: [], stated: [], corrected: [], reply: "Go on.", ...json }) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  userReplies = [];
  serviceReplies = [];
  mocks.userDb.from.mockReturnValue(fakeClient(() => userReplies, userUpdate, userInsert, userDelete));
  mocks.serviceDb.from.mockReturnValue(fakeClient(() => serviceReplies, serviceUpdate, serviceInsert, serviceDelete));
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
  { question: "What does VIF measure?", options: ["Bias", "Variance inflation", "Fit", "Skew"], correctIndex: 1,
    explanation: "It measures inflation.", source: "measures how much collinearity inflates" },
  { question: "Which VIF is a warning?", options: ["1", "2", "5", "Above ten"], correctIndex: 3,
    explanation: "Above ten is the warning.", source: "A VIF above ten is usually read as a warning" },
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

describe("mastery start: the server opens the session and holds its list", () => {
  const noted = (count: number) => ({ data: null, error: null, count }) as Result;

  it("opens with the service role, sends names only, and spends nothing", async () => {
    userReplies.push(owned(), noted(2));
    serviceReplies.push(reply(null), reply({ id: "sess" }));
    const res = await startCall();
    expect(await res.json()).toEqual({
      sessionId: "sess",
      topics: CHECKLIST.map(p => ({ ref: p.id, label: p.text })),
      turnsLeft: 12,
    });
    expect(serviceInsert).toHaveBeenCalledWith({ user_id: "alice", milestone_id: "card", topic_refs: ["p1", "p2", "p3", "p4"] });
    expect(userInsert).not.toHaveBeenCalled();
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it("abandons the last unfinished attempt, so ticks never carry into a new one", async () => {
    userReplies.push(owned(), noted(2));
    serviceReplies.push(reply(null), reply({ id: "sess" }));
    await startCall();
    expect(serviceDelete).toHaveBeenCalledOnce();
  });

  it("does not open a session it could not clear the way for", async () => {
    userReplies.push(owned(), noted(2));
    serviceReplies.push(failure("permission denied"));
    expect((await startCall()).status).toBe(500);
    expect(serviceInsert).not.toHaveBeenCalled();
  });

  it("reports a session it could not store, rather than a list with nowhere to hold ticks", async () => {
    userReplies.push(owned(), noted(2));
    serviceReplies.push(reply(null), failure("disk full"));
    expect((await startCall()).status).toBe(500);
    expect(recordOperation).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("says an older card's list isn't ready, instead of opening a session with no topics", async () => {
    userReplies.push(owned({ learning_points: null }));
    expect((await startCall()).status).toBe(409);
    expect(mocks.serviceDb.from).not.toHaveBeenCalled();
  });

  it("refuses a card with no notes, and reports a failed count as an error, not as no notes", async () => {
    userReplies.push(owned(), noted(0));
    expect((await startCall()).status).toBe(422);
    userReplies.push(owned(), failure("timeout"));
    expect((await startCall()).status).toBe(500);
  });

  it("refuses another learner's card before opening anything", async () => {
    userReplies.push(notMine);
    expect((await startCall()).status).toBe(404);
    expect(mocks.serviceDb.from).not.toHaveBeenCalled();
  });

  it("reports a failed card lookup as an error, not as a missing card", async () => {
    userReplies.push(failure("timeout"));
    expect((await startCall()).status).toBe(500);
  });
});

describe("mastery turn: ticks are earned on the server and held there", () => {
  const SAID = "VIF tells you how much the variance of a coefficient is inflated";
  const QUOTE = "variance of a coefficient is inflated";

  it("holds a verified tick with the service role, and tells the page where it stands", async () => {
    serviceReplies.push(heldSession({ covered: ["p2"], turns: 3 }), reply({ id: "sess" }));
    userReplies.push(owned(), reply([{ title: "Note", body: "x" }]));
    checked({ covered: [{ ref: "p1", quote: QUOTE }], reply: "Say more." });
    const res = await turnCall(SAID);
    expect(await res.json()).toEqual({ reply: "Say more.", covered: ["p2", "p1"], heldCount: 0, turnsLeft: 8 });
    expect(serviceUpdate).toHaveBeenCalledWith({ covered: ["p2", "p1"], held: [], turns: 4 });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("ticks nothing on a quote the learner never said, and records that it threw one out", async () => {
    serviceReplies.push(heldSession(), reply({ id: "sess" }));
    userReplies.push(owned(), reply([{ title: "Note", body: "x" }]));
    checked({ covered: [{ ref: "p1", quote: "words nobody ever said" }] });
    expect((await (await turnCall(SAID)).json()).covered).toEqual([]);
    expect(recordOperation).toHaveBeenCalledWith(expect.objectContaining({ detail: { phase: "turn", rejected: 1 } }));
  });

  it("logs what the check cost, under the name the budget gate used", async () => {
    serviceReplies.push(heldSession(), reply({ id: "sess" }));
    userReplies.push(owned(), reply([{ title: "Note", body: "x" }]));
    checked({});
    await turnCall(SAID);
    expect(mocks.ai.mock.calls[0]![2]).toBe("mastery/session");
    expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: "mastery/session", model: "claude-sonnet-4-6" }));
  });

  it("still logs the spend on a reply it cannot read, and fails the turn rather than ticking nothing", async () => {
    serviceReplies.push(heldSession());
    userReplies.push(owned(), reply([{ title: "Note", body: "x" }]));
    mocks.ai.mockResolvedValue({ content: [{ type: "text", text: "not json" }], usage: { input_tokens: 10, output_tokens: 5 } });
    expect((await turnCall(SAID)).status).toBe(502);
    expect(logUsage).toHaveBeenCalled();
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("does not count a double-send twice", async () => {
    serviceReplies.push(heldSession(), reply(null));
    userReplies.push(owned(), reply([{ title: "Note", body: "x" }]));
    checked({});
    expect((await turnCall(SAID)).status).toBe(409);
  });

  it("reports a tick it could not hold, rather than showing one the server does not have", async () => {
    serviceReplies.push(heldSession(), failure("permission denied"));
    userReplies.push(owned(), reply([{ title: "Note", body: "x" }]));
    checked({ covered: [{ ref: "p1", quote: QUOTE }] });
    expect((await turnCall(SAID)).status).toBe(500);
    expect(recordOperation).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("spends nothing once the session has used all its turns", async () => {
    serviceReplies.push(heldSession({ turns: 12 }));
    expect((await turnCall(SAID)).status).toBe(409);
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it("spends nothing on a session that has finished", async () => {
    serviceReplies.push(heldSession({ finished_at: "2026-11-05T00:00:00Z" }));
    expect((await turnCall(SAID)).status).toBe(409);
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it("spends nothing when every topic is covered and nothing needs taking back", async () => {
    serviceReplies.push(heldSession({ covered: ["p1", "p2", "p3", "p4"] }));
    userReplies.push(owned());
    const res = await turnCall(SAID);
    expect(res.status).toBe(200);
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it("refuses a session that isn't this learner's before spending", async () => {
    serviceReplies.push(reply(null));
    expect((await turnCall(SAID)).status).toBe(404);
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it("reports a failed session lookup as an error, not as a missing session", async () => {
    serviceReplies.push(failure("timeout"));
    expect((await turnCall(SAID)).status).toBe(500);
  });

  it("reports failed notes as an error on an older card, rather than checking without its authority", async () => {
    serviceReplies.push(heldSession());
    userReplies.push(owned(), failure("timeout"));
    expect((await turnCall(SAID)).status).toBe(500);
    expect(mocks.ai).not.toHaveBeenCalled();
  });
});

describe("mastery finish: the server adds up the ticks it holds and records the result", () => {
  it("validates a first pass at 70% with the service role, without a model call", async () => {
    serviceReplies.push(heldSession({ covered: ["p1", "p2", "p3"] }), reply(null), reply(null));
    userReplies.push(owned());
    expect(await (await finishCall()).json()).toEqual({
      score: 7, headline: "You covered 3 of 4 topics.", missed: ["Ridge regression"], corrections: [],
      covered: ["p1", "p2", "p3"], passed: true, record: "saved",
    });
    expect(serviceUpdate).toHaveBeenCalledWith({
      mastery_validated: true, mastery_score: 7, mastery_feedback: "You covered 3 of 4 topics. Not covered: Ridge regression.",
    });
    expect(userUpdate).not.toHaveBeenCalled();
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it("records nothing on a first attempt under 70%", async () => {
    serviceReplies.push(heldSession({ covered: ["p1", "p2"] }), reply(null));
    userReplies.push(owned());
    expect(await (await finishCall()).json()).toMatchObject({ score: 5, passed: false, record: "skipped" });
    expect(serviceUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ mastery_score: 5 }));
  });

  it("logs a practice run on a mastered card without touching the validated flag", async () => {
    serviceReplies.push(heldSession({ covered: ["p1"] }), reply(null), reply(null));
    userReplies.push(owned({ mastery_validated: true }));
    await finishCall();
    expect(serviceUpdate).toHaveBeenCalledWith({ mastery_score: 2, mastery_feedback: expect.stringContaining("1 of 4") });
  });

  it("gives the same result for the same ticks, every time", async () => {
    const run = async () => {
      serviceReplies.push(heldSession({ covered: ["p1", "p2", "p3"] }), reply(null), reply(null));
      userReplies.push(owned());
      return (await finishCall()).json();
    };
    expect(await run()).toEqual(await run());
  });

  it("reports a result it could not save, and leaves the session open so saving needs no repeat", async () => {
    serviceReplies.push(heldSession({ covered: ["p1", "p2", "p3", "p4"] }), failure("permission denied"));
    userReplies.push(owned());
    const res = await finishCall();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ score: 10, passed: true, record: "failed" });
    expect(serviceUpdate).toHaveBeenCalledOnce();
    expect(recordOperation).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("closes the session once the result is safe", async () => {
    serviceReplies.push(heldSession({ covered: ["p1", "p2", "p3", "p4"] }), reply(null), reply(null));
    userReplies.push(owned());
    await finishCall();
    expect(serviceUpdate).toHaveBeenLastCalledWith({ finished_at: expect.any(String) });
  });

  it("keeps the result when only closing the session fails", async () => {
    serviceReplies.push(heldSession({ covered: ["p1", "p2", "p3", "p4"] }), reply(null), failure("timeout"));
    userReplies.push(owned());
    expect(await (await finishCall()).json()).toMatchObject({ passed: true, record: "saved" });
  });

  it("refuses to finish with no turns, so opening a practice run can't replace a real score", async () => {
    serviceReplies.push(heldSession({ turns: 0 }));
    expect((await finishCall()).status).toBe(409);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("refuses a session that has already finished", async () => {
    serviceReplies.push(heldSession({ finished_at: "2026-11-05T00:00:00Z" }));
    expect((await finishCall()).status).toBe(409);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("refuses a session on another learner's card before recording anything", async () => {
    serviceReplies.push(heldSession({ covered: ["p1", "p2", "p3", "p4"] }));
    userReplies.push(notMine);
    expect((await finishCall()).status).toBe(404);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("counts against the list the session began with, so trimming the checklist mid-session can't raise the share", async () => {
    serviceReplies.push(heldSession({ covered: ["p1"] }), reply(null));
    userReplies.push(owned({ learning_points: [CHECKLIST[0]] }));
    expect(await (await finishCall()).json()).toMatchObject({ score: 2, passed: false });
  });
});
