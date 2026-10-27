// Success criterion 5 of PRD-narrow-learn.md: after phase 2, every retired
// route returns 410, and a test hits each one. Exercised through the real
// route handlers; only sign-in and the operations store are fakes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ userId: "alice" as string | null, record: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: async () => mocks.userId }));
vi.mock("@/lib/observability/record", () => ({ recordOperation: mocks.record }));

import { POST as classifyTopic } from "@/app/api/dashboard/classify-topic/route";
import { POST as refine } from "@/app/api/dashboard/refine/route";
import { POST as extract } from "@/app/api/dashboard/goals/document/extract/route";
import { POST as approve } from "@/app/api/dashboard/goals/document/approve/route";
import {
  CHOOSE_COURSE_HREF,
  RETIRED_ROUTE_MESSAGE,
  RETIRED_ROUTES,
  type RetiredRoute,
} from "./retiredRoute";

const handlers = {
  "dashboard/classify-topic":         classifyTopic,
  "dashboard/refine":                 refine,
  "dashboard/goals/document/extract": extract,
  "dashboard/goals/document/approve": approve,
} satisfies Record<RetiredRoute, (request: NextRequest) => Promise<Response>>;

// What each route accepted before it was retired, so a 410 here proves the
// old work is gone rather than that a malformed body was turned away.
const oldBodies: Record<RetiredRoute, string> = {
  "dashboard/classify-topic":         JSON.stringify({ topic: "SQL joins" }),
  "dashboard/refine":                 JSON.stringify({ topic: "SQL joins", answers: [] }),
  "dashboard/goals/document/extract": JSON.stringify({ text: "A syllabus" }),
  "dashboard/goals/document/approve": JSON.stringify({ extractionId: "x", end_date: "2026-12-01" }),
};

const post = (route: string, body: string) =>
  new NextRequest(`http://localhost/api/${route}`, { method: "POST", body });

beforeEach(() => {
  mocks.userId = "alice";
  mocks.record.mockReset();
});

it("pairs every retired route with its real handler, and no other", () => {
  expect(Object.keys(handlers).sort()).toEqual([...RETIRED_ROUTES].sort());
});

it("keeps the answers route live, because /privacy promises read and delete from the card", () => {
  expect(RETIRED_ROUTES as readonly string[]).not.toContain("dashboard/goals/[id]/answers");
});

describe.each(RETIRED_ROUTES)("%s", route => {
  it("answers 410 with the catalog link, even for a body it once accepted", async () => {
    for (const body of [oldBodies[route], "{", ""]) {
      const res = await handlers[route](post(route, body));
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: RETIRED_ROUTE_MESSAGE, chooseCourse: CHOOSE_COURSE_HREF });
    }
  });

  it("records a signed-in call as a refused learn.retired naming the route", async () => {
    await handlers[route](post(route, oldBodies[route]));
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledWith({
      userId:    "alice",
      operation: "learn.retired",
      outcome:   "refused",
      detail:    { route },
    });
  });

  it("turns an anonymous caller away without a record, so a scanner never counts as use", async () => {
    mocks.userId = null;
    const res = await handlers[route](post(route, oldBodies[route]));
    expect(res.status).toBe(410);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
