import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), profile: vi.fn(), log: vi.fn() }));
vi.mock("./server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: () => ({ select: () => ({ eq: () => ({ single: mocks.profile }) }) }),
  }),
}));
vi.mock("@/lib/observability/log", () => ({ logSafeError: mocks.log }));

import { getAuthenticatedUserId } from "./auth-helper";

const request = new NextRequest("https://hugh.example/api/notes/images");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "alice" } } });
  mocks.profile.mockResolvedValue({ data: { approved: true, is_blocked: false }, error: null });
});

describe("active account API gate", () => {
  it("admits an approved, unblocked session", async () => {
    expect(await getAuthenticatedUserId(request)).toBe("alice");
  });

  it("revokes the same valid session as soon as its profile is blocked", async () => {
    expect(await getAuthenticatedUserId(request)).toBe("alice");
    mocks.profile.mockResolvedValue({ data: { approved: true, is_blocked: true }, error: null });
    expect(await getAuthenticatedUserId(request)).toBeNull();
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
  });

  it.each([
    { approved: true, is_blocked: true },
    { approved: false, is_blocked: false },
    null,
  ])("refuses a still-valid session without active account status: %j", async profile => {
    mocks.profile.mockResolvedValue({ data: profile, error: null });
    expect(await getAuthenticatedUserId(request)).toBeNull();
  });

  it("fails closed when the profile read fails", async () => {
    mocks.profile.mockResolvedValue({ data: null, error: { message: "offline" } });
    expect(await getAuthenticatedUserId(request)).toBeNull();
    expect(mocks.log).toHaveBeenCalledOnce();
  });
});
