// The summary a learner reads beside the Mastery conversation is written before
// any pass and then saved on the card, where the drawer reuses it. So it must
// claim nothing they have not done yet, while a passed card keeps its keepsake.
// The route is exercised through its real handler: a wire crossed there would
// save a false sentence on the learner's card.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  from:   vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: async () => "alice" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: mocks.from }) }));
vi.mock("@/lib/usage", () => ({ enforceUsageGate: async () => null, logUsage: vi.fn() }));
vi.mock("@/lib/observability/record", () => ({ recordOperation: vi.fn() }));
vi.mock("@/lib/claude/client", () => ({
  claudeClient: () => ({ messages: { create: mocks.create } }),
}));

import { POST } from "@/app/api/tracker/milestones/[id]/summary/route";
import { masterySummaryPrompt } from "@/lib/claude/prompts";

const material = {
  topic:            "Linear regression",
  milestoneTitle:   "Multicollinearity",
  milestoneSummary: "Spot strongly related predictors and reduce them.",
  points:           [{ text: "VIF flags collinear predictors", covered: true }],
  diaryEntries:     [{ title: "VIF", body: "A VIF above 10 means trouble.", gap: "Unsure about ridge." }],
};

describe("masterySummaryPrompt before a pass", () => {
  const prompt = masterySummaryPrompt({ ...material, mastered: false, masteryScore: null, masteryFeedback: null });

  it("does not tell a learner who is about to talk that they have already mastered the card", () => {
    expect(prompt).toContain("have not done that yet");
    expect(prompt).not.toContain("just mastered");
    expect(prompt).not.toContain("celebratory");
    expect(prompt).not.toContain("What you now understand");
  });

  it("does not ask for the section saying they professed this verbally", () => {
    expect(prompt).not.toContain("## Mastery");
    expect(prompt).not.toContain("professed");
  });

  it("still gives them their own notes, gaps and key ideas to talk from", () => {
    expect(prompt).toContain("A VIF above 10 means trouble.");
    expect(prompt).toContain("Unsure about ridge.");
    expect(prompt).toContain("## The key ideas");
    expect(prompt).toContain("## Watch-outs");
  });

  it("keeps an old score and verdict out, since older rows can hold one on an unpassed card", () => {
    const old = masterySummaryPrompt({ ...material, mastered: false, masteryScore: 5, masteryFeedback: "Weak on VIF." });
    expect(old).not.toContain("5/10");
    expect(old).not.toContain("Weak on VIF.");
    expect(old).not.toContain("not yet scored");
  });
});

describe("masterySummaryPrompt after a pass", () => {
  const prompt = masterySummaryPrompt({ ...material, mastered: true, masteryScore: 8, masteryFeedback: "Clear on VIF." });

  it("keeps the keepsake, with the score and verdict in it", () => {
    expect(prompt).toContain("just mastered");
    expect(prompt).toContain("keepsake");
    expect(prompt).toContain("## What you now understand");
    expect(prompt).toContain("## Mastery");
    expect(prompt).toContain("8/10");
    expect(prompt).toContain("Clear on VIF.");
  });

  it("does not carry the warning that they have not done it yet", () => {
    expect(prompt).not.toContain("have not done that yet");
  });
});

// ── Through the route ──────────────────────────────────────────────────────

type Reply = { data: unknown; error: null };

const select = vi.fn();

/** A table's chain, answering every read with that table's one reply. */
function table(answer: Reply) {
  const chain = {
    select: (columns: string) => { select(columns); return chain; },
    update: () => chain,
    eq:     () => chain,
    order:  () => chain,
    single: async () => answer,
    then:   (resolve: (r: Reply) => unknown) => Promise.resolve(answer).then(resolve),
  };
  return chain;
}

function card(over: Record<string, unknown>) {
  return {
    id: "card", title: "Multicollinearity", summary: "Spot related predictors.",
    kanban_column: "done", learning_points: [], coverage: null,
    mastery_validated: false, mastery_score: null, mastery_feedback: null,
    tracks: { user_id: "alice", topic_description: "Linear regression" },
    ...over,
  };
}

async function promptSentFor(over: Record<string, unknown>): Promise<string> {
  mocks.from.mockImplementation((name: string) =>
    name === "milestone_entries"
      ? table({ data: [{ title: "VIF", body: "A VIF above 10 means trouble.", gap_note: null }], error: null })
      : table({ data: card(over), error: null }),
  );

  const res = await POST(
    new NextRequest("http://localhost/api/tracker/milestones/card/summary", { method: "POST" }),
    { params: Promise.resolve({ id: "card" }) },
  );
  expect(res.status).toBe(200);

  return mocks.create.mock.calls[0][0].messages[0].content as string;
}

describe("the summary route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({
      content: [{ type: "text", text: "# Multicollinearity" }],
      usage:   { input_tokens: 10, output_tokens: 5 },
    });
  });

  it("asks for a guide on a card that has not been passed", async () => {
    const prompt = await promptSentFor({ mastery_validated: false });
    expect(prompt).toContain("have not done that yet");
    expect(prompt).not.toContain("just mastered");
  });

  it("does not mistake an old score on an unpassed card for a pass", async () => {
    const prompt = await promptSentFor({ mastery_validated: false, mastery_score: 5, mastery_feedback: "Weak." });
    expect(prompt).toContain("have not done that yet");
    expect(prompt).not.toContain("5/10");
  });

  it("asks for the keepsake on a passed card", async () => {
    const prompt = await promptSentFor({ mastery_validated: true, mastery_score: 8, mastery_feedback: "Clear." });
    expect(prompt).toContain("just mastered");
    expect(prompt).toContain("8/10");
  });

  it("reads whether the card was passed, because a column it never selected would look like false", async () => {
    await promptSentFor({ mastery_validated: true });
    expect(select.mock.calls[0][0]).toContain("mastery_validated");
  });
});
