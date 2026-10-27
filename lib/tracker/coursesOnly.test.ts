// Narrow Learn PR D, through the real route handlers: a goal is only ever a
// course from the catalog, and only a course can be rebuilt. Sign-in, the
// database, the build and the operations store are fakes; the routes, the
// catalog and the copy are real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Result = { data: unknown; error: { message: string } | null; count?: number | null };

const mocks = vi.hoisted(() => ({
  userDb:    { from: vi.fn() },
  serviceDb: { from: vi.fn() },
  record:    vi.fn(),
  generate:  vi.fn(),
  after:     vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: async () => "alice" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.userDb }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => mocks.serviceDb }));
vi.mock("@/lib/observability/record", () => ({ recordOperation: mocks.record }));
vi.mock("@/lib/tracker/generate", () => ({ generateTrack: mocks.generate }));

import { POST as goals } from "@/app/api/dashboard/goals/route";
import { POST as retry } from "@/app/api/dashboard/goals/[id]/retry/route";
import { TOPIC_GOAL_MESSAGE } from "@/lib/learn/retiredRoute";
import { CHOOSE_COURSE_HREF, EARLIER_TOPIC_NO_REBUILD, isCourseGoal } from "@/lib/learn/earlierTopic";

const COURSE = "linear-regression";

// One canned answer per table, and a log of every write, so a test can say
// both what a route read and what it changed.
let rows: Record<string, Result>;
let writes: string[];

function fakeTable(db: string, table: string) {
  const result = (): Result => rows[table] ?? { data: null, error: null, count: 0 };
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "limit", "is"]) chain[name] = () => chain;
  for (const name of ["insert", "update", "delete"]) {
    chain[name] = (value?: unknown) => {
      writes.push(`${db}:${name}:${table}${value && typeof value === "object" && "track_status" in value ? `:${String((value as { track_status: unknown }).track_status)}` : ""}`);
      return chain;
    };
  }
  chain.single      = () => Promise.resolve(result());
  chain.maybeSingle = () => Promise.resolve(result());
  chain.then        = (resolve: (r: Result) => unknown) => Promise.resolve(result()).then(resolve);
  return chain;
}

const post = (body: unknown, raw = false) =>
  new NextRequest("http://localhost/api/dashboard/goals", { method: "POST", body: raw ? String(body) : JSON.stringify(body) });
const rebuild = (goalId = "goal") =>
  retry(new NextRequest(`http://localhost/api/dashboard/goals/${goalId}/retry`, { method: "POST" }), { params: Promise.resolve({ id: goalId }) });

/** Run whatever the route left for after(), as the platform would. */
async function runAfter() {
  for (const [work] of mocks.after.mock.calls as [() => Promise<void>][]) await work();
}

const legacyGoal = (source_kind: "qa" | "document") => ({
  data: {
    id: "goal", user_id: "alice", topic: "SQL joins", source_kind, pack_id: null,
    track_status: "failed", track_started_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z",
  },
  error: null,
});

beforeEach(() => {
  rows   = {};
  writes = [];
  mocks.userDb.from.mockReset().mockImplementation((table: string) => fakeTable("user", table));
  mocks.serviceDb.from.mockReset().mockImplementation((table: string) => fakeTable("service", table));
  mocks.record.mockReset();
  mocks.generate.mockReset().mockResolvedValue("track");
  mocks.after.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("isCourseGoal", () => {
  it("calls only a catalog goal a course, so every typed or uploaded topic is an earlier topic", () => {
    expect(isCourseGoal({ source_kind: "pack" })).toBe(true);
    expect(isCourseGoal({ source_kind: "qa" })).toBe(false);
    expect(isCourseGoal({ source_kind: "document" })).toBe(false);
  });
});

describe("POST /dashboard/goals takes only a course", () => {
  it("refuses a typed topic with the catalog link, saving nothing and building nothing", async () => {
    const res = await goals(post({ topic: "SQL joins", end_date: "2026-12-31", answers: [] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: TOPIC_GOAL_MESSAGE, chooseCourse: CHOOSE_COURSE_HREF });
    expect(writes).toEqual([]);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("counts a typed topic as use of the closed path, so phase 3 sees a stale tab", async () => {
    await goals(post({ topic: "SQL joins", end_date: "2026-12-31", answers: [] }));
    expect(mocks.record).toHaveBeenCalledWith({
      userId: "alice", operation: "learn.retired", outcome: "refused", detail: { route: "dashboard/goals:topic" },
    });
  });

  it("still starts a course, building it from its pack after the response", async () => {
    rows.profiles       = { data: { is_blocked: false }, error: null };
    rows.learning_goals = { data: { id: "goal", topic: "Linear regression", track_status: "pending" }, error: null };
    const res = await goals(post({ packId: COURSE, end_date: "2026-12-31" }));
    expect(res.status).toBe(200);
    await runAfter();
    expect(mocks.generate).toHaveBeenCalledWith(expect.anything(), "alice", { kind: "pack", packId: COURSE }, "goal");
    expect(writes).toEqual(["user:insert:learning_goals:pending", "service:update:learning_goals:ready"]);
  });

  it("settles a course whose build throws as failed, never leaving it pending (Rule 3)", async () => {
    rows.profiles       = { data: { is_blocked: false }, error: null };
    rows.learning_goals = { data: { id: "goal", topic: "Linear regression", track_status: "pending" }, error: null };
    mocks.generate.mockRejectedValue(new Error("board write failed"));
    expect((await goals(post({ packId: COURSE, end_date: "2026-12-31" }))).status).toBe(200);
    await runAfter();
    expect(writes).toEqual(["user:insert:learning_goals:pending", "service:update:learning_goals:failed"]);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ operation: "track.build", outcome: "failed" }));
  });

  it("still turns malformed and oversized bodies away before anything else", async () => {
    expect((await goals(post("{", true))).status).toBe(400);
    expect((await goals(post("x".repeat(200_000), true))).status).toBe(413);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe("POST /dashboard/goals/[id]/retry rebuilds only a course", () => {
  it.each(["qa", "document"] as const)(
    "refuses a %s earlier topic with the catalog link, before it counts, writes or builds anything",
    async kind => {
      rows.learning_goals = legacyGoal(kind);
      const res = await rebuild();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: EARLIER_TOPIC_NO_REBUILD, chooseCourse: CHOOSE_COURSE_HREF, verdict: "earlier-topic",
      });
      expect(mocks.serviceDb.from).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
      expect(mocks.after).not.toHaveBeenCalled();
      expect(mocks.record).toHaveBeenCalledWith({
        userId: "alice", operation: "track.retry", outcome: "refused",
        detail: { reason: "earlier-topic", source: kind },
      });
    },
  );

  it("rebuilds a broken course from its pack, clearing the old track first", async () => {
    rows.learning_goals    = {
      data: {
        id: "goal", user_id: "alice", topic: "Linear regression", source_kind: "pack", pack_id: COURSE,
        track_status: "failed", track_started_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z",
      },
      error: null,
    };
    rows.track_generations = { data: null, error: null, count: 1 };
    rows.profiles          = { data: { is_blocked: false }, error: null };
    const res = await rebuild();
    expect(res.status).toBe(200);
    await runAfter();
    expect(mocks.generate).toHaveBeenCalledWith(expect.anything(), "alice", { kind: "pack", packId: COURSE }, "goal");
    expect(writes).toEqual([
      "user:update:learning_goals:pending",
      "service:delete:tracks",
      "service:update:learning_goals:ready",
    ]);
  });
});
