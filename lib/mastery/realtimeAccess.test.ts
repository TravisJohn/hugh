import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { canUseRealtime } from "./realtimeAccess";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), verify: vi.fn(), from: vi.fn(), gate: vi.fn(), usage: vi.fn(), provider: vi.fn(), eq: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: mocks.auth }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: mocks.from }) }));
vi.mock("@/lib/supabase/verify-access", () => ({ verifyUserAccess: mocks.verify }));
vi.mock("@/lib/usage", () => ({ enforceUsageGate: mocks.gate, logUsage: mocks.usage }));
vi.mock("@/lib/observability/record", () => ({ recordOperation: vi.fn() }));
vi.mock("@/app/mastery/[milestoneId]/MasteryRealtimeClient", () => ({ default: () => "realtime preview" }));
vi.mock("@/components/monitor/RecordActivity", () => ({ default: () => null }));

import { POST as mint } from "@/app/api/tracker/mastery/realtime-session/route";
import { POST as report } from "@/app/api/tracker/mastery/realtime-usage/route";
import MasteryPage from "@/app/mastery/[milestoneId]/page";

let profile: Record<string, unknown> | null;
let profileError: { message: string } | null;
let milestoneFound: boolean;
function request(body: unknown = { milestoneId: "milestone" }) {
  return new NextRequest("http://localhost/api/tracker/mastery/realtime-session", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MASTERY_REALTIME_ENABLED", "true");
  vi.stubEnv("OPENAI_API_KEY", "test-only-not-a-real-key");
  vi.stubGlobal("fetch", mocks.provider);
  // The test runner uses classic JSX; Next uses its own automatic JSX runtime.
  vi.stubGlobal("React", React);
  mocks.auth.mockResolvedValue("alice");
  mocks.gate.mockResolvedValue(null);
  mocks.provider.mockResolvedValue(new Response(JSON.stringify({ value: "test-credential", expires_at: 123 }), { status: 200 }));
  profile = { is_admin: false, is_blocked: false, approved: true };
  profileError = null;
  milestoneFound = true;
  mocks.verify.mockImplementation(async () => ({ user: { id: "alice" }, profile }));
  mocks.from.mockImplementation((table: string) => {
    const result = table === "profiles" ? { data: profile, error: profileError }
      : table === "milestone_entries" ? { data: [], count: 1, error: null }
      : { data: milestoneFound ? { id: "milestone", title: "SQL", summary_doc: "A short summary", kanban_column: "done", tracks: { user_id: "alice", goal_id: "goal" } } : null, error: null };
    const chain = { select: vi.fn(), eq: vi.fn(), single: vi.fn(), then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve) };
    chain.select.mockReturnValue(chain);
    chain.single.mockReturnValue(chain);
    chain.eq.mockImplementation((...args: unknown[]) => { mocks.eq(...args); return chain; });
    return chain;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Realtime preview access policy", () => {
  it.each([undefined, "false", "TRUE", "1", ""])("flag %s does not enable the preview", flag => {
    expect(canUseRealtime(flag, { is_admin: true, is_blocked: false })).toBe(false);
  });
  it.each([null, undefined, {}, { is_admin: false }, { is_admin: true }, { is_admin: true, is_blocked: null }, { is_admin: true, is_blocked: true }])("fails closed for profile %j", value => {
    expect(canUseRealtime("true", value)).toBe(false);
  });
  it("admits only an explicit unblocked administrator with the flag on", () => {
    expect(canUseRealtime("true", { is_admin: true, is_blocked: false })).toBe(true);
  });
});

describe("credential issuance is the security boundary", () => {
  it("keeps the disabled flag closed even for administrators", async () => {
    profile = { is_admin: true, is_blocked: false };
    vi.stubEnv("MASTERY_REALTIME_ENABLED", "false");
    expect((await mint(request())).status).toBe(404);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("requires authentication", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await mint(request())).status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it.each(["free", "pro"])("refuses an approved %s learner even with forged request flags", async plan => {
    profile = { is_admin: false, is_blocked: false, approved: true, plan };
    expect((await mint(request({ milestoneId: "milestone", is_admin: true, approved: true, plan: "pro", userId: "admin" }))).status).toBe(403);
    expect(mocks.eq).toHaveBeenCalledWith("user_id", "alice");
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalledWith("milestones");
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it.each([null, { is_admin: true, is_blocked: true }, { is_admin: "true", is_blocked: false }])("refuses missing, blocked or invalid profile %j", async value => {
    profile = value;
    expect((await mint(request())).status).toBe(403);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("does not trust data returned alongside a profile read error", async () => {
    profile = { is_admin: true, is_blocked: false };
    profileError = { message: "database unavailable" };
    expect((await mint(request())).status).toBe(503);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("fails closed on a thrown profile lookup", async () => {
    mocks.from.mockImplementation(() => { throw new Error("database unavailable"); });
    expect((await mint(request())).status).toBe(503);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("retains the administrator's usage gate", async () => {
    profile = { is_admin: true, is_blocked: false };
    mocks.gate.mockResolvedValue(NextResponse.json({ error: "rate limit" }, { status: 429 }));
    expect((await mint(request())).status).toBe(429);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("retains milestone ownership checks", async () => {
    profile = { is_admin: true, is_blocked: false };
    milestoneFound = false;
    expect((await mint(request())).status).toBe(404);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("admits the administrator preview without changing the provider model", async () => {
    profile = { is_admin: true, is_blocked: false };
    const response = await mint(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ clientSecret: "test-credential", model: "gpt-realtime-mini" });
    expect(mocks.provider).toHaveBeenCalledOnce();
    expect(mocks.gate).toHaveBeenCalledWith("alice", "mastery/realtime");
  });
});

describe("mastery page agrees with the API", () => {
  async function render(classic?: string) {
    return renderToStaticMarkup(await MasteryPage({ params: Promise.resolve({ milestoneId: "milestone" }), searchParams: Promise.resolve({ returnUrl: undefined, classic }) }));
  }
  it.each(["free", "pro"])("shows unavailable for %s learners with the flag on", async plan => {
    profile = { is_admin: false, is_blocked: false, approved: true, plan };
    expect(await render()).toContain("Live voice mastery is unavailable");
  });
  it("renders the administrator preview only when enabled", async () => {
    profile = { is_admin: true, is_blocked: false };
    expect(await render()).toContain("realtime preview");
    vi.stubEnv("MASTERY_REALTIME_ENABLED", "false");
    expect(await render()).toContain("Live voice mastery is unavailable");
  });
  it("ignores the retired classic query option", async () => {
    profile = { is_admin: true, is_blocked: false };
    expect(await render("1")).toContain("realtime preview");
  });
});

it("still accepts best-effort usage reports from sessions predating containment", async () => {
  vi.stubEnv("MASTERY_REALTIME_ENABLED", "false");
  const response = await report(request({ milestoneId: "milestone", usage: { audioIn: 10, audioOut: 5 } }));
  expect(response.status).toBe(200);
  expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({ userId: "alice", feature: "mastery/realtime", tokensIn: 10, tokensOut: 5 }));
  expect(mocks.provider).not.toHaveBeenCalled();
});
