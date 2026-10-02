import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
import { callIdFromLocation, eventUsage, monitorCall, usageCost } from "./liveVoiceControl";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("server-owned Realtime event accounting", () => {
  it("accepts only an OpenAI call Location", () => {
    expect(callIdFromLocation("/v1/realtime/calls/rtc_ABC-123")).toBe("rtc_ABC-123");
    expect(callIdFromLocation("https://other.test/v1/realtime/calls/rtc_x")).toBeNull();
    expect(callIdFromLocation("/v1/realtime/calls/../../other")).toBeNull();
  });
  it("keys a completed response by provider response ID and prices its audio and text separately", () => {
    const usage = eventUsage({ type: "response.done", response: {
      id: "resp_1", usage: { input_tokens: 120, output_tokens: 55,
        input_token_details: { audio_tokens: 100, text_tokens: 20 },
        output_token_details: { audio_tokens: 50, text_tokens: 5 } },
    } });
    expect(usage?.key).toBe("response:resp_1");
    expect(usage?.totals).toMatchObject({ audioIn: 100, audioOut: 50, textIn: 20, textOut: 5 });
    expect(usageCost(usage!.totals)).toBeCloseTo(100 * 10 / 1e6 + 50 * 20 / 1e6 + 20 * 0.6 / 1e6 + 5 * 2.4 / 1e6);
  });
  it("does not invent a deduplication key for an unidentifiable event", () => {
    expect(eventUsage({ type: "response.done", response: { usage: { input_tokens: 10 } } })).toBeNull();
  });
  it("hangs up on server-observed cost even when the browser sends no end request", async () => {
    class FakeSocket extends EventEmitter {
      terminate() { this.emit("close"); }
    }
    const socket = new FakeSocket();
    const provider = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", provider);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    mocks.rpc.mockResolvedValue({ data: 0.21, error: null });
    mocks.from.mockImplementation(() => {
      const chain = { update: vi.fn(), eq: vi.fn(), in: vi.fn() };
      chain.update.mockReturnValue(chain);
      chain.eq.mockReturnValue(chain);
      chain.in.mockResolvedValue({ error: null });
      return chain;
    });
    const observing = monitorCall(socket as unknown as WebSocket, "session", "rtc_call", "user", Date.now() + 120000, new Date().toISOString());
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done", response: {
      id: "response-1", usage: { input_tokens: 100, output_tokens: 100 },
    } })));
    await observing;
    expect(mocks.rpc).toHaveBeenCalledWith("record_mastery_realtime_event", expect.objectContaining({ p_event_key: "response:response-1" }));
    expect(provider).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls/rtc_call/hangup", expect.objectContaining({ method: "POST" }));
    vi.unstubAllEnvs();
  });
});
