import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), admin: vi.fn(), from: vi.fn(), end: vi.fn() }));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: mocks.auth }));
vi.mock("@/lib/auth/requireAdmin", () => ({ requireAdminApi: mocks.admin }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/mastery/liveVoiceControl", () => ({ endCall: mocks.end }));

import { POST as endOwn } from "@/app/api/tracker/mastery/realtime-end/route";
import { POST as endAdmin } from "@/app/api/admin/voice/[id]/route";
import { GET as recover } from "@/app/api/internal/mastery-realtime-recover/route";

const SESSION = "00000000-0000-4000-8000-000000000002";
const request = (body: unknown) => new NextRequest("http://localhost/api/tracker/mastery/realtime-end", {
  method: "POST", body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue("alice");
  mocks.admin.mockResolvedValue({ userId: "admin" });
  mocks.end.mockResolvedValue(true);
  mocks.from.mockImplementation(() => {
    const chain = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.single.mockResolvedValue({ data: { id: SESSION, provider_call_id: "rtc_call", state: "active" }, error: null });
    return chain;
  });
});

describe("Live voice termination", () => {
  it("requires the owner for a user-requested hangup", async () => {
    mocks.from.mockImplementation(() => {
      const chain = { select: vi.fn(), eq: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: { message: "not found" } }) };
      chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain);
      return chain;
    });
    expect((await endOwn(request({ sessionId: SESSION, reason: "user_ended" }))).status).toBe(404);
    expect(mocks.end).not.toHaveBeenCalled();
  });
  it("hangs up the owned provider call and does not trust a browser call ID", async () => {
    const response = await endOwn(request({ sessionId: SESSION, callId: "rtc_attacker", reason: "user_ended" }));
    expect(response.status).toBe(200);
    expect(mocks.end).toHaveBeenCalledWith(SESSION, "rtc_call", "user_ended");
  });
  it("requires admin access for the kill switch", async () => {
    mocks.admin.mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    const response = await endAdmin(new Request("http://localhost"), { params: Promise.resolve({ id: SESSION }) });
    expect(response.status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("allows the admin to end a call", async () => {
    const response = await endAdmin(new Request("http://localhost"), { params: Promise.resolve({ id: SESSION }) });
    expect(response.status).toBe(200);
    expect(mocks.end).toHaveBeenCalledWith(SESSION, "rtc_call", "admin_ended");
  });
  it("requires a recovery secret", async () => {
    vi.stubEnv("CRON_SECRET", "secret");
    const response = await recover(new NextRequest("http://localhost/api/internal/mastery-realtime-recover"));
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
