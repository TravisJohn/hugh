import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ db: { from: vi.fn(), storage: { from: vi.fn() } }, ai: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: async () => "alice" }));
vi.mock("@/lib/auth/requireProvisioned", () => ({ requireProvisionedApi: async () => null }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => mocks.db }));
vi.mock("@/lib/usage", () => ({ enforceUsageGate: async () => null, logUsage: vi.fn() }));
vi.mock("@/lib/observability/record", () => ({ recordOperation: vi.fn() }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: mocks.ai } }; } }));

import { GET as images, DELETE as deleteImage, PATCH as patchImage } from "@/app/api/notes/images/route";
import { GET as documentFile } from "@/app/api/monitor/documents/file/route";
import { POST as coach } from "@/app/api/notes/coach/route";
import { DELETE as deleteNote } from "@/app/api/notes/notes/route";
import { DELETE as deleteNotebook } from "@/app/api/notes/notebooks/route";

type Result = { data: unknown; error: { message: string } | null };
let replies: Result[];
const sign = vi.fn();
const remove = vi.fn();
const download = vi.fn();
const update = vi.fn();
const deleteRow = vi.fn();
const row = (path: string) => ({ id: "image", note_id: "note", storage_path: path, parent_image_id: null });
const reply = (data: unknown): Result => ({ data, error: null });

function request(path: string, method = "GET", body?: object) {
  return new NextRequest(`http://localhost${path}`, {
    method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "test-only");
  vi.spyOn(console, "error").mockImplementation(() => {});
  replies = [];
  const result = () => {
    const next = replies.shift();
    if (!next) throw new Error("Unexpected database query");
    return Promise.resolve(next);
  };
  const chain = {
    select: () => chain, eq: () => chain, in: () => chain, order: () => chain,
    maybeSingle: result, single: result,
    then: (resolve: (r: Result) => unknown) => result().then(resolve),
    update, delete: deleteRow,
  };
  update.mockReturnValue(chain);
  deleteRow.mockReturnValue(chain);
  mocks.db.from.mockReturnValue(chain);
  mocks.db.storage.from.mockReturnValue({ createSignedUrl: sign, remove, download });
  sign.mockResolvedValue({ data: { signedUrl: "https://example.invalid/signed" }, error: null });
  remove.mockResolvedValue({ error: null });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("S1: actual route handlers reject poisoned references before privileged work", () => {
  it("does not sign any image in a mixed-owner listing", async () => {
    replies.push(reply([row("alice/note/ok.png"), row("bob/note/private.png")]));
    expect((await images(request("/api/notes/images?note_id=note"))).status).toBe(502);
    expect(sign).not.toHaveBeenCalled();
  });
  it("still signs an owned screenshot", async () => {
    replies.push(reply([row("alice/note/ok.png")]));
    expect((await images(request("/api/notes/images?note_id=note"))).status).toBe(200);
    expect(sign).toHaveBeenCalledWith("alice/note/ok.png", 3600);
  });
  it.each(["bob/doc/cv.pdf", "alice/../bob/cv.pdf", "alice/%2e%2e/bob/cv.pdf"])("refuses document %s", async (path) => {
    replies.push(reply({ file_path: path, file_name: "cv.pdf" }));
    expect((await documentFile(request("/api/monitor/documents/file?version=v"))).status).toBe(502);
    expect(sign).not.toHaveBeenCalled();
  });
  it("still signs an owned document for download", async () => {
    replies.push(reply({ file_path: "alice/doc/cv.pdf", file_name: "cv.pdf" }));
    expect((await documentFile(request("/api/monitor/documents/file?version=v&download=1"))).status).toBe(200);
    expect(sign).toHaveBeenCalledWith("alice/doc/cv.pdf", 300, { download: "cv.pdf" });
  });
  it("does not delete a bucket if one of its snips points at Bob", async () => {
    replies.push(reply(row("alice/note/ok.png")), reply([row("bob/note/private.png")]));
    expect((await deleteImage(request("/api/notes/images?id=image", "DELETE"))).status).toBe(502);
    expect(remove).not.toHaveBeenCalled();
    expect(deleteRow).not.toHaveBeenCalled();
  });
  it("deletes owned image bytes and its row", async () => {
    replies.push(reply(row("alice/note/ok.png")), reply([]), reply(null));
    expect((await deleteImage(request("/api/notes/images?id=image", "DELETE"))).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(["alice/note/ok.png"]);
    expect(deleteRow).toHaveBeenCalledOnce();
  });
  it("does not delete rows when the image lookup fails", async () => {
    replies.push({ data: null, error: { message: "read failed" } });
    expect((await deleteImage(request("/api/notes/images?id=image", "DELETE"))).status).toBe(502);
    expect(remove).not.toHaveBeenCalled();
    expect(deleteRow).not.toHaveBeenCalled();
  });
  it("does not promote a poisoned snip", async () => {
    replies.push(reply({ ...row("bob/note/private.png"), parent_image_id: "parent" }), reply(row("alice/note/ok.png")));
    expect((await patchImage(request("/api/notes/images", "PATCH", { id: "image", promote: true }))).status).toBe(502);
    expect(update).not.toHaveBeenCalled();
  });
  it("does not download or send a poisoned Coach snip to OpenAI", async () => {
    replies.push(reply(row("alice/note/ok.png")), reply([]), reply([row("bob/note/private.png")]));
    expect((await coach(request("/api/notes/coach", "POST", { image_id: "image" }))).status).toBe(502);
    expect(download).not.toHaveBeenCalled();
    expect(mocks.ai).not.toHaveBeenCalled();
  });
  it("refuses note cleanup before removing bytes or cascading rows", async () => {
    replies.push(reply({ is_group: false }), reply([row("bob/note/private.png")]));
    expect((await deleteNote(request("/api/notes/notes?id=note", "DELETE"))).status).toBe(502);
    expect(remove).not.toHaveBeenCalled();
    expect(deleteRow).not.toHaveBeenCalled();
  });
  it("refuses notebook cleanup before removing bytes or cascading rows", async () => {
    replies.push(reply({ is_group: false }), reply([{ id: "note" }]), reply([row("bob/note/private.png")]));
    expect((await deleteNotebook(request("/api/notes/notebooks?id=book", "DELETE"))).status).toBe(502);
    expect(remove).not.toHaveBeenCalled();
    expect(deleteRow).not.toHaveBeenCalled();
  });
});
