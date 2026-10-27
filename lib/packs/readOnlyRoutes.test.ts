// Narrow Learn PR D, decision 2, through the real route handlers: an earlier
// topic is read-only. Every route that changes a card or spends on it refuses
// one with the read-only sentence and changes nothing; reading and deleting
// stay open. Sign-in, the database, the budget and the model are fakes; the
// routes, the grounding and the copy are real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Result = { data: unknown; error: { message: string } | null; count?: number | null };

const mocks = vi.hoisted(() => ({
  userDb:    { from: vi.fn(), auth: { getUser: async () => ({ data: { user: { id: "alice" } } }) } },
  serviceDb: { from: vi.fn() },
  ai:        vi.fn(),
  gate:      vi.fn(),
  record:    vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: async () => "alice" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.userDb }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => mocks.serviceDb }));
vi.mock("@/lib/usage", () => ({ enforceUsageGate: mocks.gate, checkUsageAllowed: async () => ({ allowed: true }), logUsage: vi.fn() }));
vi.mock("@/lib/observability/record", () => ({ recordOperation: mocks.record }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: mocks.ai }; } }));

import { PATCH as moveCard } from "@/app/api/tracker/milestones/[id]/route";
import { POST as addEntry, GET as readEntries } from "@/app/api/tracker/milestones/[id]/entries/route";
import { PATCH as editEntry } from "@/app/api/tracker/entries/[entryId]/route";
import { PATCH as reorder } from "@/app/api/tracker/tracks/[trackId]/reorder/route";
import { GET as readChecklist, POST as saveChecklist } from "@/app/api/tracker/milestones/[id]/coverage/route";
import { POST as summarise, PUT as saveSummary } from "@/app/api/tracker/milestones/[id]/summary/route";
import { POST as recap } from "@/app/api/tracker/mastery/recap/route";
import { POST as saveSession } from "@/app/api/learn/save-summary/route";
import { CHOOSE_COURSE_HREF, EARLIER_TOPIC_READ_ONLY } from "@/lib/learn/earlierTopic";
import { CARDLESS_SAVE_MESSAGE } from "@/lib/learn/retiredRoute";

// One canned answer per table, and a log of every write, so a test can say
// both what a route read and what it changed.
let rows: Record<string, Result>;
let writes: string[];

function fakeTable(db: string, table: string) {
  const result = (): Result => rows[table] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "in", "order", "limit", "is"]) chain[name] = () => chain;
  for (const name of ["insert", "update", "delete"]) chain[name] = () => { writes.push(`${db}:${name}:${table}`); return chain; };
  chain.single      = () => Promise.resolve(result());
  chain.maybeSingle = () => Promise.resolve(result());
  chain.then        = (resolve: (r: Result) => unknown) => Promise.resolve(result()).then(resolve);
  return chain;
}

/** An earlier topic: a card with no concept ids, owned by the learner. */
const earlierCard = {
  id: "card", title: "SQL joins", summary: "Joins.", kanban_column: "done", position: 1,
  concept_ids: null, learning_points: [{ id: "p1", text: "Keys match rows." }], coverage: null,
  mastery_score: null, mastery_feedback: null, tracks: { user_id: "alice", topic_description: "SQL" },
};

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/x", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = <K extends string>(key: K) => ({ params: Promise.resolve({ [key]: key === "trackId" ? "track" : "card" } as Record<K, string>) });

beforeEach(() => {
  rows   = { milestones: { data: earlierCard, error: null } };
  writes = [];
  mocks.userDb.from.mockReset().mockImplementation((table: string) => fakeTable("user", table));
  mocks.serviceDb.from.mockReset().mockImplementation((table: string) => fakeTable("service", table));
  mocks.ai.mockReset();
  mocks.gate.mockReset().mockResolvedValue(null);
  mocks.record.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const refusedWrites: Array<[string, () => Promise<Response>, () => void]> = [
  ["moving a card to another column",           () => moveCard(req("PATCH", { column: "learn" }), params("id")),       () => {}],
  ["adding a diary entry",                       () => addEntry(req("POST", { body: "A new note." }), params("id")),    () => {}],
  ["editing what a diary entry says",            () => editEntry(req("PATCH", { body: "Rewritten." }), params("entryId")), () => {
    rows.milestone_entries = { data: { id: "card", milestone_id: "card", body: "Old.", correction: null }, error: null };
  }],
  ["accepting a suggested correction",           () => editEntry(req("PATCH", { action: "accept" }), params("entryId")),   () => {
    rows.milestone_entries = { data: { id: "card", milestone_id: "card", body: "Old.", correction: "New." }, error: null };
  }],
  ["reordering the backlog",                     () => reorder(req("PATCH", { orderedIds: ["a", "b"] }), params("trackId")), () => {
    rows.tracks     = { data: { id: "track" }, error: null };
    rows.milestones = { data: [{ id: "a", position: 1, concept_ids: null }, { id: "b", position: 2, concept_ids: null }], error: null };
  }],
  ["saving checklist progress",                  () => saveChecklist(req("POST", { statuses: { p1: "understood" } }), params("id")), () => {}],
  ["generating a mastery summary",               () => summarise(req("POST"), params("id")),                               () => {}],
  ["saving an edited summary",                   () => saveSummary(req("PUT", { summaryDoc: "My summary." }), params("id")), () => {}],
  ["drawing up a mastery recap",                 () => recap(req("POST", { milestoneId: "card", transcript: [] })),          () => {}],
  ["saving an Ask session to the card",          () => saveSession(req("POST", { topic: "SQL", story: "S", takeaway: "T", milestoneId: "card" })), () => {}],
];

describe("an earlier topic refuses every change and every spend", () => {
  it.each(refusedWrites)("refuses %s with the read-only sentence, writing nothing and spending nothing", async (_name, call, arrange) => {
    arrange();
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: EARLIER_TOPIC_READ_ONLY, chooseCourse: CHOOSE_COURSE_HREF });
    expect(writes).toEqual([]);
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.gate).not.toHaveBeenCalled();   // no budget reserved for a refusal
  });
});

describe("an earlier topic stays readable and deletable", () => {
  it("lists its diary", async () => {
    rows.milestone_entries = { data: [{ id: "e1", body: "A note." }], error: null };
    const res = await readEntries(req("GET"), params("id"));
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toHaveLength(1);
  });

  it("archives a diary entry, which is how the diary deletes", async () => {
    rows.milestone_entries = { data: { id: "card", milestone_id: "card", body: "Old." }, error: null };
    const res = await editEntry(req("PATCH", { action: "archive" }), params("entryId"));
    expect(res.status).toBe(200);
    expect(writes).toEqual(["user:update:milestone_entries"]);
  });

  it("shows the checklist it already has, without generating one", async () => {
    const res = await readChecklist(req("GET"), params("id"));
    expect(res.status).toBe(200);
    expect((await res.json()).learningPoints).toEqual(earlierCard.learning_points);
    expect(mocks.ai).not.toHaveBeenCalled();
  });
});

describe("an Ask session that names no card", () => {
  it("is refused with its own words and counted as the closed path, adding no card", async () => {
    const res = await saveSession(req("POST", { topic: "SQL", story: "S", takeaway: "T", goalId: "goal" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(CARDLESS_SAVE_MESSAGE);
    expect(writes).toEqual([]);
    expect(mocks.record).toHaveBeenCalledWith({
      userId: "alice", operation: "learn.retired", outcome: "refused", detail: { route: "learn/save-summary:no-card" },
    });
  });
});
