import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), usageGate: vi.fn(), ttsGate: vi.fn(), convert: vi.fn(),
  logUsage: vi.fn(), record: vi.fn(),
}));
vi.mock("elevenlabs", () => ({
  ElevenLabsClient: class { textToSpeech = { convert: mocks.convert }; },
}));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: mocks.user }));
vi.mock("@/lib/personas", () => ({ getPersonaById: () => ({ voiceId: "test-voice" }) }));
vi.mock("@/lib/usage", () => ({
  enforceUsageGate: mocks.usageGate,
  enforceTtsBudget: mocks.ttsGate,
  logUsage: mocks.logUsage,
}));
vi.mock("@/lib/observability/record", () => ({ recordOperation: mocks.record }));

import { POST } from "@/app/api/tts/route";

const request = (body: unknown) => new NextRequest("https://hugh.example/api/tts", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ELEVENLABS_API_KEY = "test-key";
  mocks.user.mockResolvedValue("alice");
  mocks.usageGate.mockResolvedValue(null);
  mocks.ttsGate.mockResolvedValue(null);
  mocks.record.mockResolvedValue(undefined);
  mocks.convert.mockResolvedValue((async function* () { yield Buffer.from("audio"); })());
});
afterEach(() => { delete process.env.ELEVENLABS_API_KEY; });

describe("TTS admission before the provider call", () => {
  it("rejects malformed text before consuming either allowance", async () => {
    expect((await POST(request({ text: 42, personaId: "wise" }))).status).toBe(400);
    expect(mocks.usageGate).not.toHaveBeenCalled();
    expect(mocks.ttsGate).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it.each([429, 503])("does not call ElevenLabs after a %i character-gate refusal", async status => {
    mocks.ttsGate.mockResolvedValue(NextResponse.json({ error: "refused" }, { status }));
    expect((await POST(request({ text: "Hello", personaId: "wise" }))).status).toBe(status);
    expect(mocks.ttsGate).toHaveBeenCalledWith("alice", 5);
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it("calls the provider only after both gates admit the request", async () => {
    const response = await POST(request({ text: "Hello", personaId: "wise" }));
    expect(response.status).toBe(200);
    expect(mocks.usageGate).toHaveBeenCalledWith("alice", "tts");
    expect(mocks.ttsGate).toHaveBeenCalledWith("alice", 5);
    expect(mocks.convert).toHaveBeenCalledOnce();
    expect(mocks.logUsage).toHaveBeenCalledWith(expect.objectContaining({ ttsChars: 5 }));
  });
});
