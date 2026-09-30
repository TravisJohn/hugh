import "server-only";
import { NextResponse } from "next/server";
import { parseTextBody, TEXT_LIMITS, TextInputError, type TextBodies, type TextRoute } from "./textInput";

/** Stop reading before JSON parsing; Content-Length alone is attacker-controlled. */
export async function readTextRequest<K extends TextRoute>(request: Request, kind: K): Promise<{ body: TextBodies[K]; response?: never } | { body?: never; response: NextResponse }> {
  const reader = request.body?.getReader();
  try {
    const declared = Number(request.headers.get("content-length"));
    if (declared > TEXT_LIMITS.requestBytes) throw new TextInputError("Request is too large. Shorten the text and try again.", 413);
    if (!reader) throw new TextInputError("Request body is required.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > TEXT_LIMITS.requestBytes) throw new TextInputError("Request is too large. Shorten the text and try again.", 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { body: parseTextBody(kind, value) };
  } catch (error) {
    return { response: NextResponse.json({ error: error instanceof TextInputError ? error.message : "Invalid JSON request." }, { status: error instanceof TextInputError ? error.status : 400 }) };
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}
