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
import { CHOOSE_COURSE_HREF, EARLIER_TOPIC_READ_ONLY } from "@/lib/learn/earlierTopic";
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
    is: () => chain, returns: () => chain, update: () => chain, insert: () => chain,
    maybeSingle: next, single: next,
    then: (resolve: (r: Result) => unknown) => next().then(resolve),
  };
  return chain;
}

const card = (conceptIds: string[]) => reply({
  id: "card", title: "Multicollinearity", mastery_validated: false,
  concept_ids: conceptIds, tracks: { user_id: "alice" },
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

  it("refuses an earlier topic with the read-only sentence and the catalog link, and spends nothing", async () => {
    // narrow Learn PR D: this card used to be taught from the browser's topic.
    userReplies = [card([])];
    const res = await ask({ milestoneId: "card" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: EARLIER_TOPIC_READ_ONLY, chooseCourse: CHOOSE_COURSE_HREF });
    expect(mocks.ai).not.toHaveBeenCalled();
  });

  it("refuses a request that names no card, before the database or the model", async () => {
    // Ask teaches one card since PR D; there is no open-topic tutor to fall back to.
    const res = await ask({});
    expect(res.status).toBe(400);
    expect(mocks.userDb.from).not.toHaveBeenCalled();
    expect(mocks.ai).not.toHaveBeenCalled();
  });
});

// ── Mastery ─────────────────────────────────────────────────────────────────

describe("scripted mastery on a course card (PRD row 4)", () => {
  const evaluate = () => session(post("/api/tracker/mastery/session", {
    milestoneId: "card", scenario: "interview", phase: "evaluate",
    messages: [{ role: "hugh", text: "What does VIF do?" }, { role: "learner", text: "It removes multicollinearity." }],
  }));

  it("judges against the syllabus and asks which wrong beliefs were held", async () => {
    userReplies = [card(COURSE_CARD), notes];
    mocks.ai.mockResolvedValue(text(JSON.stringify({ score: 6, feedback: "Partly.", passed: false, misconceptionsHeld: [] })));
    await evaluate();
    const prompt = mocks.ai.mock.calls[0]![3].messages[0].content as string;
    expect(prompt).toContain(syllabus);
    expect(prompt).toContain('"misconceptionsHeld"');
    expect(prompt).toMatch(/relative to the course syllabus above/);
  });

  it("fails a high score that left a wrong belief standing, writes nothing, and gives the course's correction", async () => {
    userReplies = [card(COURSE_CARD), notes];
    mocks.ai.mockResolvedValue(text(JSON.stringify({ score: 9, feedback: "Fluent.", passed: true, misconceptionsHeld: [vifRef] })));
    const res  = await evaluate();
    const body = await res.json();
    expect(body).toMatchObject({ score: 9, passed: false, record: "skipped" });
    expect(body.feedback).toContain(vif.correction);
    expect(body.feedback).toContain(vif.source.href);
    expect(mocks.serviceDb.from).not.toHaveBeenCalled();
  });

  it("refuses an evaluation that left out the misconception list, rather than passing on silence", async () => {
    userReplies = [card(COURSE_CARD), notes];
    mocks.ai.mockResolvedValue(text(JSON.stringify({ score: 9, feedback: "Fluent.", passed: true })));
    expect((await evaluate()).status).toBe(500);
    expect(mocks.serviceDb.from).not.toHaveBeenCalled();
  });

  it("refuses an earlier topic's session with the read-only sentence, scoring and recording nothing", async () => {
    // narrow Learn PR D: this card used to be judged against its own notes.
    userReplies = [card([]), notes];
    const res = await evaluate();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: EARLIER_TOPIC_READ_ONLY, chooseCourse: CHOOSE_COURSE_HREF });
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.serviceDb.from).not.toHaveBeenCalled();
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

  it("refuses to check an earlier topic's note, with the read-only sentence", async () => {
    userReplies = [
      reply({ id: "e1", body: "A note.", milestone_id: "card", gap_note: null }),
      reply({ title: "SQL joins", concept_ids: null, tracks: { topic_description: "t" } }),
    ];
    const res = await check();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(EARLIER_TOPIC_READ_ONLY);
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

  it("refuses an earlier topic's quiz with the read-only sentence, generating and storing nothing", async () => {
    // narrow Learn PR D: this card used to get a quiz drawn from its notes alone.
    userReplies = [card([]), notes];
    const res = await generate();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(EARLIER_TOPIC_READ_ONLY);
    expect(mocks.claude).not.toHaveBeenCalled();
    expect(mocks.serviceDb.from).not.toHaveBeenCalled();
  });
});
