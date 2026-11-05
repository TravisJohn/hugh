import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { SubscriptionCallError } from "@/lib/claude/subscription/errors";
import { MAX_IMAGE_FILE_BYTES } from "@/lib/claude/imageInput";

// The Coach and the summary, end to end with Claude and the database stood in
// for. What only a route can get wrong is the order of things: nothing is spent
// before the gate, nothing goes unlogged after it, and a failed read never
// passes for an empty thread.

interface Result { data: unknown; error: unknown }

const mocks = vi.hoisted(() => ({
  user: vi.fn(), provisioned: vi.fn(), gate: vi.fn(), logUsage: vi.fn(), record: vi.fn(),
  create: vi.fn(), createWithImages: vi.fn(),
  rows: {} as Record<string, Result[]>,
  files: {} as Record<string, Uint8Array>,
  inserted: [] as unknown[],
}));

function query(table: string) {
  const take = () => mocks.rows[table]?.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {
    insert: (row: unknown) => { mocks.inserted.push(row); return chain; },
    maybeSingle: async () => take(),
    single: async () => take(),
    then: (resolve: (value: Result) => unknown) => resolve(take()),
  };
  for (const method of ["select", "eq", "order"]) chain[method] = () => chain;
  return chain;
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/auth-helper", () => ({ getAuthenticatedUserId: mocks.user }));
vi.mock("@/lib/auth/requireProvisioned", () => ({ requireProvisionedApi: mocks.provisioned }));
vi.mock("@/lib/usage", () => ({ enforceUsageGate: mocks.gate, logUsage: mocks.logUsage }));
vi.mock("@/lib/observability/record", () => ({ recordOperation: mocks.record }));
vi.mock("@/lib/claude/client", () => ({
  claudeClient: () => ({ messages: { create: mocks.create, createWithImages: mocks.createWithImages } }),
  subscriptionConfigDir: () => "C:\\hugh-test-config",
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: query,
    storage: {
      from: () => ({
        download: async (path: string) => {
          const bytes = mocks.files[path];
          return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { message: "gone" } };
        },
      }),
    },
  }),
}));

import { POST as coach } from "@/app/api/notes/coach/route";
import { POST as summarize } from "@/app/api/notes/summarize/route";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const SONNET = "claude-sonnet-4-6";

const request = (path: string) => new NextRequest(`https://hugh.example${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image_id: "img-1" }),
});
const pressCoach = () => coach(request("/api/notes/coach"));
const pressSummary = () => summarize(request("/api/notes/summarize"));

const planReply = (text: string) => ({
  content: text ? [{ type: "text", text }] : [],
  usage: { input_tokens: 3, cache_creation_input_tokens: 1976, output_tokens: 151 },
});
const ok = (data: unknown): Result => ({ data, error: null });
const broken: Result = { data: null, error: { message: "connection lost" } };
const outcomes = () => mocks.record.mock.calls.map(([event]) => event.outcome);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.user.mockResolvedValue("alice");
  mocks.provisioned.mockResolvedValue(null);
  mocks.gate.mockResolvedValue(null);
  mocks.createWithImages.mockResolvedValue(planReply("A is right."));
  mocks.create.mockResolvedValue(planReply("- The trap was cost."));
  mocks.inserted.length = 0;
  mocks.files = { "alice/n1/top.png": PNG, "alice/n1/bottom.jpg": JPEG };
  mocks.rows = {
    note_images: [
      ok({ note_id: "n1", storage_path: "alice/n1/top.png", mime: "image/png", parent_image_id: null }),
      ok([{ storage_path: "alice/n1/bottom.jpg", mime: "image/jpeg" }]),
    ],
    note_messages: [
      ok([{ role: "user", content: "I picked B." }]),
      ok({ id: "m2", note_id: "n1", image_id: "img-1", role: "assistant", content: "A is right." }),
    ],
  };
});

describe("POST /api/notes/coach", () => {
  it("sends every slice to Claude in stacking order with the learner's thread, and saves the reply", async () => {
    const response = await pressCoach();
    expect(response.status).toBe(200);

    const [call, options] = mocks.createWithImages.mock.calls[0];
    expect(call.model).toBe(SONNET);
    expect(call.images.map((image: { mediaType: string }) => image.mediaType)).toEqual(["image/png", "image/jpeg"]);
    expect(call.messages).toEqual([{ role: "user", content: "I picked B." }]);
    // One admitted attempt: an SDK retry would spend past what the gate agreed to.
    expect(options).toEqual({ maxRetries: 0 });
    expect(mocks.inserted).toEqual([
      { user_id: "alice", note_id: "n1", image_id: "img-1", role: "assistant", content: "A is right." },
    ]);
    expect(outcomes()).toEqual(["ok"]);
  });

  it("gates and logs under one name and the one model, counting the plan's cache writes as spend", async () => {
    await pressCoach();
    expect(mocks.gate).toHaveBeenCalledWith("alice", "notes/coach", expect.any(Number));
    expect(mocks.logUsage).toHaveBeenCalledWith({
      userId: "alice", model: SONNET, feature: "notes/coach", tokensIn: 1979, tokensOut: 151,
    });
  });

  it("spends nothing when the usage gate refuses, and passes on the gate's own reply", async () => {
    mocks.gate.mockResolvedValue(NextResponse.json({ error: "Monthly limit reached." }, { status: 429 }));
    const response = await pressCoach();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Monthly limit reached." });
    expect(mocks.createWithImages).not.toHaveBeenCalled();
    expect(mocks.logUsage).not.toHaveBeenCalled();
    expect(outcomes()).toEqual(["refused"]);
  });

  it("spends nothing for an account that doesn't have Notes switched on", async () => {
    mocks.provisioned.mockResolvedValue(NextResponse.json({ error: "Notes is off." }, { status: 403 }));
    expect((await pressCoach()).status).toBe(403);
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.createWithImages).not.toHaveBeenCalled();
  });

  it("tells the learner the plan's own reason, because \"try again\" is wrong when the limit is out until Thursday", async () => {
    mocks.createWithImages.mockRejectedValue(new SubscriptionCallError("limit_reached", "out", null));
    const response = await pressCoach();
    expect(response.status).toBe(429);
    expect((await response.json()).error).toContain("usage limit has been reached");
    expect(outcomes()).toEqual(["refused"]);
  });

  it("refuses an oversized screenshot with its own message before spending anything", async () => {
    const big = new Uint8Array(MAX_IMAGE_FILE_BYTES + 1);
    big.set(PNG);
    mocks.files["alice/n1/bottom.jpg"] = big;
    const response = await pressCoach();
    expect(response.status).toBe(413);
    expect((await response.json()).error).toContain("smaller copy");
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.createWithImages).not.toHaveBeenCalled();
    expect(outcomes()).toEqual(["refused"]);
  });

  it("stops if one slice can't be read, because half a question gets a confident wrong answer", async () => {
    delete mocks.files["alice/n1/bottom.jpg"];
    const response = await pressCoach();
    expect(response.status).toBe(502);
    expect(mocks.createWithImages).not.toHaveBeenCalled();
    expect(outcomes()).toEqual(["failed"]);
  });

  it("treats a failed thread read as a failure, not as a learner who wrote nothing", async () => {
    mocks.rows.note_messages = [broken];
    expect((await pressCoach()).status).toBe(502);
    expect(mocks.createWithImages).not.toHaveBeenCalled();
    expect(outcomes()).toEqual(["failed"]);
  });

  it("treats a failed screenshot lookup as a failure, not as \"not found\"", async () => {
    mocks.rows.note_images = [broken];
    expect((await pressCoach()).status).toBe(502);
  });

  it("still logs a billed reply that came back empty, and shows it as a failure", async () => {
    mocks.createWithImages.mockResolvedValue(planReply(""));
    const response = await pressCoach();
    expect(response.status).toBe(502);
    expect(mocks.logUsage).toHaveBeenCalledTimes(1);
    expect(mocks.inserted).toEqual([]);
    expect(outcomes()).toEqual(["failed"]);
  });

  it("refuses a snip, because only a bucket owns a thread", async () => {
    mocks.rows.note_images = [ok({ note_id: "n1", storage_path: "alice/n1/top.png", mime: "image/png", parent_image_id: "other" })];
    expect((await pressCoach()).status).toBe(400);
    expect(mocks.createWithImages).not.toHaveBeenCalled();
  });
});

describe("POST /api/notes/summarize", () => {
  beforeEach(() => {
    mocks.rows = {
      note_images: [ok({ id: "img-1" })],
      note_messages: [ok([{ role: "user", content: "I picked B." }, { role: "assistant", content: "A is right." }])],
    };
  });

  it("summarises the thread on Claude and returns the notes", async () => {
    const response = await pressSummary();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: "- The trap was cost." });
    const [call] = mocks.create.mock.calls[0];
    expect(call.model).toBe(SONNET);
    expect(call.messages[0].content).toContain("Learner: I picked B.");
    expect(call.messages[0].content).toContain("Hugh: A is right.");
  });

  it("gates and logs under one name and the one model", async () => {
    await pressSummary();
    expect(mocks.gate).toHaveBeenCalledWith("alice", "notes/summarize", expect.any(Number));
    expect(mocks.logUsage).toHaveBeenCalledWith({
      userId: "alice", model: SONNET, feature: "notes/summarize", tokensIn: 1979, tokensOut: 151,
    });
  });

  it("spends nothing on a thread with nothing in it", async () => {
    mocks.rows.note_messages = [ok([])];
    expect((await pressSummary()).status).toBe(400);
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("treats a failed thread read as a failure, not as \"nothing to summarise yet\"", async () => {
    mocks.rows.note_messages = [broken];
    expect((await pressSummary()).status).toBe(502);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("tells the learner the plan's own reason when the plan can't serve the call", async () => {
    mocks.create.mockRejectedValue(new SubscriptionCallError("signed_out", "expired"));
    const response = await pressSummary();
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("login");
  });
});
