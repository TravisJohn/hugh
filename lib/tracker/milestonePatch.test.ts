import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: async () => "learner" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { PATCH } from "@/app/api/tracker/milestones/[id]/route";

describe("milestone mastery results", () => {
  it("rejects an invalid body before touching the database", async () => {
    const request = new NextRequest("http://localhost/api/tracker/milestones/card", {
      method: "PATCH",
      body: "null",
    });
    expect((await PATCH(request, { params: Promise.resolve({ id: "card" }) })).status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each([
    { masteryValidated: true },
    { masteryValidated: false },
    { masteryScore: 10 },
    { masteryFeedback: "passed" },
    { masteryValidated: null, column: "done" },
  ])("refuses client supplied result fields before writing: %j", async body => {
    const request = new NextRequest("http://localhost/api/tracker/milestones/card", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: "card" }) });
    expect(response.status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
