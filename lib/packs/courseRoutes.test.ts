// Narrow Learn PR B, exercised through the real route handlers: a course card
// (one whose concept_ids name a reference pack) is taught, checked, quizzed
// and scored against its syllabus, and every other card is left exactly as it
// was. The model and the database are fakes; the prompts and the pack are real.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Result = { data: unknown; error: { message: string } | null };

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
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: mocks.claude }; } }));
vi.mock("@/lib/observability/record", () => ({ recordOperation: vi.fn() }));
vi.mock("@/lib/claude/textRequest", () => ({ readTextRequest: async (req: NextRequest) => ({ body: await req.json() }) }));
vi.mock("@/lib/claude/textBudget", () => ({ createTextMessage: mocks.ai, textBudgetResponse: () => null }));

import { POST as chat } from "@/app/api/learn/chat/route";
import { POST as session } from "@/app/api/tracker/mastery/session/route";
import { POST as verify } from "@/app/api/tracker/entries/[entryId]/verify/route";
import { POST as quiz } from "@/app/api/tracker/review/quiz/route";
import { focusedLearningSystemPrompt } from "@/lib/claude/prompts";
import { cardGrounding, GROUNDING_REFUSAL_MESSAGE, misconceptionsByRef, renderCardSyllabus, type CardGround } from "./grounding";

const COURSE_CARD = ["linear-regression:collinearity"];
const ground: CardGround = (() => {
  const g = cardGrounding(COURSE_CARD);
  if (g.kind !== "ok") throw new Error("the collinearity card must ground");
  return g.ground;
})();
const [vifRef, vif] = [...misconceptionsByRef(ground)][0]!;
const syllabus = renderCardSyllabus(ground);

let userReplies: Result[];
let serviceReplies: Result[];
const reply = (data: unknown): Result => ({ data, error: null });

function fakeClient(replies: () => Result[]) {
  const next = () => {
    const r = replies().shift();
    if (!r) throw new Error("Unexpected database query");
    return Promise.resolve(r);
  };
  const chain = {
    select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
    is: () => chain, returns: () => chain, update: () => chain, insert: () => chain, delete: () => chain,
    maybeSingle: next, single: next,
    then: (resolve: (r: Result) => unknown) => next().then(resolve),
  };
  return chain;
}

const card = (conceptIds: string[], over: Record<string, unknown> = {}) => reply({
  id: "card", title: "Multicollinearity", mastery_validated: false,
  concept_ids: conceptIds, tracks: { user_id: "alice" }, ...over,
});
const notes = reply([{ title: "VIF", body: "Collinear predictors inflate coefficient variance.", covered: null }]);
const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body) });
const text = (t: string) => ({ content: [{ type: "text", text: t }], usage: { input_tokens: 10, output_tokens: 5 } });

beforeEach(() => {
  userReplies = [];
  serviceReplies = [];
  mocks.userDb.from.mockImplementation(() => fakeClient(() => userReplies));
  mocks.serviceDb.from.mockImplementation(() => fakeClient(() => serviceReplies));
  mocks.ai.mockReset();
  mocks.claude.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ── Ask Hugh ────────────────────────────────────────────────────────────────

describe("Ask on a course card", () => {
  const ask = (extra: Record<string, unknown>) => chat(post("/api/learn/chat", {
    topic: "Whatever the browser says", messages: [{ role: "user", content: "Does VIF remove multicollinearity?" }], ...extra,
  }));

  it("is taught from the syllabus, built on the server, not from the browser's topic", async () => {
    userReplies = [card(COURSE_CARD)];
    mocks.ai.mockResolvedValue(text('{"reply":"No.","isOffTopic":false,"codeExample":null,"covered":false}'));
    expect((await ask({ milestoneId: "card" })).status).toBe(200);

    const system = mocks.ai.mock.calls[0]![3].system as string;
    expect(system).toContain(syllabus);
    expect(system).toContain(`${ground.subject}: Multicollinearity`);
    expect(system).not.toContain("Whatever the browser says");
  });

  it("is refused in its own words when the card's course can't be taught, and spends nothing", async () => {
    userReplies = [card(["linear-regression:gone"])];
    const res = await ask({ milestoneId: "card" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(GROUNDING_REFUSAL_MESSAGE["unknown-concept"]);
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it("leaves an open-topic card on today's prompt, with the browser's topic", async () => {
    userReplies = [card([])];
    mocks.ai.mockResolvedValue(text('{"reply":"Hi","isOffTopic":false,"codeExample":null,"covered":false}'));
    await ask({ milestoneId: "card" });
    expect(mocks.ai.mock.calls[0]![3].system).toBe(focusedLearningSystemPrompt("Whatever the browser says"));
  });

  it("asks nothing of the database when no card is named, exactly as before", async () => {
    mocks.ai.mockResolvedValue(text('{"reply":"Hi","isOffTopic":false,"codeExample":null,"covered":false}'));
    await ask({});
    expect(mocks.userDb.from).not.toHaveBeenCalled();
  });
});

// ── Mastery ─────────────────────────────────────────────────────────────────

describe("a mastery session on a course card (PRD row 4)", () => {
  const URL = "/api/tracker/mastery/session";
  const refs = ground.concepts.flatMap(c => c.keyPoints.map(k => k.ref));
  const heldRow = (over: Record<string, unknown> = {}) => reply({
    id: "sess", milestone_id: "card", topic_refs: refs, covered: [], held: [], turns: 1, finished_at: null, ...over,
  });
  const start = () => session(post(URL, { phase: "start", milestoneId: "card" }));
  const turn = (said: string) => session(post(URL, { phase: "turn", sessionId: "sess", said, recent: [] }));
  const finish = () => session(post(URL, { phase: "finish", sessionId: "sess" }));
  const check = (over: Record<string, unknown> = {}) => mocks.ai.mockResolvedValue(text(JSON.stringify({
    covered: [], stated: [], corrected: [], reply: "Go on.", ...over,
  })));
  const noted = { data: null, error: null, count: 1 } as Result;

  it("offers the pack's topics by name, keeping the statements behind them on the server", async () => {
    userReplies = [card(COURSE_CARD), noted];
    serviceReplies = [reply(null), reply({ id: "sess" })];
    const body = await (await start()).json();
    expect(body.topics.map((t: { ref: string }) => t.ref)).toEqual(refs);
    expect(JSON.stringify(body)).not.toContain(ground.concepts[0]!.keyPoints[0]!.text);
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it("refuses a card whose course can't be taught, in its own words, before opening a session", async () => {
    userReplies = [card(["linear-regression:no-such-concept"])];
    const res = await start();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(GROUNDING_REFUSAL_MESSAGE["unknown-concept"]);
    expect(mocks.serviceDb.from).not.toHaveBeenCalled();
  });

  it("judges a turn against the card's source-checked points, not the learner's notes", async () => {
    userReplies = [card(COURSE_CARD)];
    serviceReplies = [heldRow(), reply({ id: "sess" })];
    check();
    expect((await turn("It inflates the variance")).status).toBe(200);
    const prompt = mocks.ai.mock.calls[0]![3].messages[0].content as string;
    expect(prompt).toContain(ground.concepts[0]!.keyPoints[0]!.text);
    expect(prompt).toContain(vif.claim);
    expect(prompt).not.toContain("<learner_notes>");
  });

  it("holds a listed wrong belief the learner stated, and says so to the page", async () => {
    userReplies = [card(COURSE_CARD)];
    serviceReplies = [heldRow(), reply({ id: "sess" })];
    check({ stated: [{ ref: vifRef, quote: vif.claim }] });
    expect(await (await turn(vif.claim)).json()).toMatchObject({ heldCount: 1 });
  });

  it("fails full coverage that left a wrong belief standing, writes nothing, and gives the course's correction", async () => {
    userReplies = [card(COURSE_CARD)];
    serviceReplies = [heldRow({ covered: refs, held: [vifRef] }), reply({ id: "sess" })];
    const body = await (await finish()).json();
    expect(body).toMatchObject({ score: 10, passed: false, record: "skipped" });
    expect(body.corrections).toHaveLength(1);
    expect(body.corrections[0]).toMatchObject({ correction: vif.correction, href: vif.source.href });
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it("judges an older card on its own checklist and notes, with no syllabus in sight", async () => {
    userReplies = [card([], { learning_points: [{ id: "p1", text: "What VIF measures" }] }), notes];
    serviceReplies = [heldRow({ topic_refs: ["p1"] }), reply({ id: "sess" })];
    check();
    expect((await turn("It measures inflation")).status).toBe(200);
    const prompt = mocks.ai.mock.calls[0]![3].messages[0].content as string;
    expect(prompt).toContain("<learner_notes>");
    expect(prompt).toContain("What VIF measures");
    expect(prompt).not.toContain("<course_syllabus>");
  });
});

// ── The diary check ─────────────────────────────────────────────────────────

describe("the diary check on a course card", () => {
  const check = () => verify(post("/api/tracker/entries/e1/verify", {}), { params: Promise.resolve({ entryId: "e1" }) });

  it("judges the note against the syllabus, not the model's general knowledge", async () => {
    userReplies = [
      reply({ id: "e1", body: "VIF removes multicollinearity.", milestone_id: "card", gap_note: null }),
      reply({ title: "Multicollinearity", concept_ids: COURSE_CARD, tracks: { topic_description: "anything" } }),
      reply({ id: "e1", fact_status: "incorrect" }),
    ];
    mocks.claude.mockResolvedValue(text('{"status":"incorrect","correction":"VIF measures it.","gap":"VIF only measures."}'));
    expect((await check()).status).toBe(200);
    const prompt = mocks.claude.mock.calls[0]![0].messages[0].content as string;
    expect(prompt).toContain(syllabus);
    expect(prompt).toMatch(/A statement the syllabus does not address is NOT an error/);
  });

  it("is refused in its own words when the card's course can't be taught", async () => {
    userReplies = [
      reply({ id: "e1", body: "A note.", milestone_id: "card", gap_note: null }),
      reply({ title: "Multicollinearity", concept_ids: ["not-a-course:x"], tracks: { topic_description: "t" } }),
    ];
    const res = await check();
    expect(res.status).toBe(503);
    expect(mocks.claude).not.toHaveBeenCalled();
  });
});

// ── The review quiz ─────────────────────────────────────────────────────────

describe("the review quiz on a course card", () => {
  const question = (keyPoint?: string) => ({
    question: "What does collinearity inflate?", options: ["Variance", "Bias", "R-squared", "Sample size"],
    correctIndex: 0, explanation: "Notes say so.", source: "Collinear predictors inflate coefficient variance",
    ...(keyPoint ? { keyPoint } : {}),
  });
  const generate = () => quiz(post("/api/tracker/review/quiz", { milestoneId: "card" }));

  it("asks for questions tied to the card's key points, alongside the notes rule", async () => {
    userReplies = [card(COURSE_CARD), notes];
    serviceReplies = [reply({ id: "quiz-1" })];
    mocks.claude.mockResolvedValue(text(JSON.stringify([question("collinearity:1"), question("collinearity:2")])));
    expect((await generate()).status).toBe(200);
    const prompt = mocks.claude.mock.calls[0]![0].messages[0].content as string;
    expect(prompt).toContain(syllabus);
    expect(prompt).toContain('"keyPoint": "conceptId:n"');
  });

  it("drops questions that test nothing on the syllabus, and refuses a quiz left too thin", async () => {
    userReplies = [card(COURSE_CARD), notes];
    mocks.claude.mockResolvedValue(text(JSON.stringify([question(), question("least_squares:1")])));
    const res = await generate();
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("insufficient_material");
    expect(mocks.serviceDb.from).not.toHaveBeenCalled();
  });

  it("keeps an open-topic card's quiz exactly as it was", async () => {
    userReplies = [card([]), notes];
    serviceReplies = [reply({ id: "quiz-1" })];
    mocks.claude.mockResolvedValue(text(JSON.stringify([question(), question()])));
    expect((await generate()).status).toBe(200);
    const prompt = mocks.claude.mock.calls[0]![0].messages[0].content as string;
    expect(prompt).not.toContain("<course_syllabus>");
    expect(prompt).not.toContain("keyPoint");
  });
});
