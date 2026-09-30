import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readTextRequest } from "./textRequest";
import { TEXT_LIMITS } from "./textInput";

describe("bounded request reader", () => {
  it("accepts a normal JSON body", async () => {
    const result = await readTextRequest(new Request("http://local", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }) }), "code");
    expect(result.body?.messages[0].content).toBe("hello");
  });
  it.each(["{", "null", '{"messages":42}'])("returns 400 for %s", async body => {
    const result = await readTextRequest(new Request("http://local", { method: "POST", body }), "code");
    expect(result.response?.status).toBe(400);
  });
  it.each([undefined, "1", String(TEXT_LIMITS.requestBytes + 1)])("enforces real bytes regardless of Content-Length %s", async length => {
    const result = await readTextRequest(new Request("http://local", { method: "POST", headers: length ? { "content-length": length } : {}, body: "x".repeat(TEXT_LIMITS.requestBytes + 1) }), "code");
    expect(result.response?.status).toBe(413);
  });
  it("stops an oversized stream before reading the tail", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(100000)); }, cancel });
    const request = new Request("http://local", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect((await readTextRequest(request, "code")).response?.status).toBe(413);
    expect(reads).toBeLessThanOrEqual(3);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
