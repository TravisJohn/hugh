import { type NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { requireProvisionedApi } from "@/lib/auth/requireProvisioned";
import { enforceUsageGate, logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { createServiceClient } from "@/lib/supabase/service";
import { NOTE_IMAGES_BUCKET } from "@/lib/notes/storage";
import { assertOwnedStoragePaths } from "@/lib/storage/ownership";
import { buildCoachMessages, type CoachThreadMessage } from "@/lib/notes/coachPrompt";
import type { NoteMessage } from "@/types";

export const dynamic = "force-dynamic";
// Vision + a short reply can take a few seconds, and a multi-snip bucket sends
// up to four images; give it headroom.
export const maxDuration = 90;

// The Coach reads screenshots, so it needs a vision-capable model.
// Kept in one place so the API call and the usage log can never disagree
// about what was billed.
const MODEL = "gpt-4o";

// The Coach: Hugh reads ONE screenshot + that screenshot's chat thread and
// appends a correction. Threads are per screenshot, so the Coach's attention is
// scoped to the exact image the learner is looking at. This is the only Notes
// route that calls an LLM, so it's the only one that can be slow or cost money —
// it runs only on an explicit "Coach" press. Model + client pattern mirror
// app/api/architecture/chat.
//
// "One screenshot" can be several snips: a question too tall to capture in one
// go is stored as a bucket plus its parts (migration 034). Every slice goes in
// the same request, in order, so the model sees the whole question — that is
// the entire point of buckets.

const unauth = () => NextResponse.json({ error: "Not signed in." }, { status: 401 });

// POST /api/notes/coach { image_id } → { message: NoteMessage } (assistant reply)
export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return unauth();

  // Privacy pass: this surface holds personal material and is off by
  // default (migration 050). RLS stops the browser reaching the tables
  // and bucket directly; this stops our own service-role client, which
  // bypasses RLS entirely.
  const denied = await requireProvisionedApi(userId, "notes");
  if (denied) {
    // Notes is off by default since the privacy pass. Being turned away is the
    // system working, so it is 'refused' — never a failure.
    void recordOperation({
      userId, operation: "notes.coach", outcome: "refused",
      detail: { reason: "not-provisioned" },
    });
    return denied;
  }

  const usageGate = await enforceUsageGate(userId, "notes/coach");
  if (usageGate) {
    void recordOperation({
      userId, operation: "notes.coach", outcome: "refused",
      detail: { reason: "usage-gate" },
    });
    return usageGate;
  }

  const body = (await request.json().catch(() => ({}))) as { image_id?: string };
  const imageId = body.image_id?.trim();
  if (!imageId) return NextResponse.json({ error: "image_id required" }, { status: 400 });

  // Instantiate per request so the build never needs the key; a missing key is
  // a graceful 503, not a crash — this feature is optional per deployment.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "The Coach isn't configured on this deployment (missing OPENAI_API_KEY)." },
      { status: 503 },
    );
  }

  const startedAt = Date.now();

  try {
    const db = createServiceClient();

    // Ownership: resolve the screenshot (and its note) for this user.
    const { data: image } = await db
      .from("note_images").select("note_id, storage_path, mime, parent_image_id")
      .eq("id", imageId).eq("user_id", userId).maybeSingle();
    if (!image) return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });
    if (image.parent_image_id) {
      // Only buckets own a thread; a snip is part of one, never a target itself.
      return NextResponse.json({ error: "That's a slice of another screenshot." }, { status: 400 });
    }

    // This screenshot's thread only.
    const { data: msgRows } = await db
      .from("note_messages").select("role, content").eq("user_id", userId).eq("image_id", imageId)
      .order("created_at", { ascending: true });
    const thread = (msgRows ?? []) as CoachThreadMessage[];

    // The bucket's own image first, then its snips in stacking order — the same
    // order the learner sees them in the pane.
    const { data: partRows } = await db
      .from("note_images").select("storage_path, mime")
      .eq("user_id", userId).eq("parent_image_id", imageId)
      .order("position", { ascending: true }).order("created_at", { ascending: true });
    const slices = [image, ...(partRows ?? [])] as Array<{ storage_path: string; mime: string }>;
    assertOwnedStoragePaths(userId, slices.map((slice) => slice.storage_path));

    // Inline each slice's bytes as a base64 data URL so the model gets them
    // directly (no dependency on OpenAI reaching Supabase Storage). If ANY slice
    // is unreadable we stop: half a question would produce a confident answer to
    // something the learner never asked.
    const dataUrls = await Promise.all(slices.map((s) => toDataUrl(db, s.storage_path, s.mime)));
    if (dataUrls.some((u) => u === null)) {
      void recordOperation({
        userId, operation: "notes.coach", outcome: "failed",
        durationMs: Date.now() - startedAt, detail: { stage: "read-screenshot" },
      });
      return NextResponse.json({ error: "Couldn't read that screenshot. Try again." }, { status: 502 });
    }

    const messages = buildCoachMessages(thread, dataUrls as string[]);

    const openai = new OpenAI({ apiKey });
    const res = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      messages,
    });
    // OpenAI names these prompt_/completion_tokens, not input_/output_tokens.
    void logUsage({
      userId,
      model:     MODEL,
      feature:   "notes/coach",
      tokensIn:  res.usage?.prompt_tokens     ?? 0,
      tokensOut: res.usage?.completion_tokens ?? 0,
    });
    // Visibility into OpenAI's automatic prompt caching (no code lever to pull —
    // it kicks in on its own once the shared system+image prefix clears ~1024
    // tokens). Cheap to leave in: one log line, no impact on the response.
    console.log(
      `[notes/coach] prompt_tokens=${res.usage?.prompt_tokens ?? "?"} ` +
      `cached_tokens=${res.usage?.prompt_tokens_details?.cached_tokens ?? 0}`,
    );

    const reply = res.choices[0]?.message?.content?.trim();
    if (!reply) {
      // Billed and empty: logUsage above already charged for this attempt, so
      // it must show as a failure rather than vanish.
      void recordOperation({
        userId, operation: "notes.coach", outcome: "failed",
        durationMs: Date.now() - startedAt, detail: { stage: "empty-reply" },
      });
      return NextResponse.json({ error: "The Coach couldn't respond just now. Try again." }, { status: 502 });
    }

    const { data, error } = await db
      .from("note_messages")
      .insert({ user_id: userId, note_id: image.note_id, image_id: imageId, role: "assistant", content: reply })
      .select("id, note_id, image_id, role, content, created_at")
      .single();
    if (error) throw error;

    void recordOperation({
      userId, operation: "notes.coach", outcome: "ok",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ message: data as NoteMessage });
  } catch (e) {
    console.error("[notes/coach] failed:", e);
    void recordOperation({
      userId, operation: "notes.coach", outcome: "failed",
      durationMs: Date.now() - startedAt, error: e,
    });
    return NextResponse.json({ error: "The Coach ran into a problem. Try again." }, { status: 502 });
  }
}

// Download one screenshot from Storage and encode it as a data: URL, or null on
// failure (a single unreadable image shouldn't sink the whole Coach turn).
async function toDataUrl(
  db: ReturnType<typeof createServiceClient>,
  storagePath: string,
  mime: string,
): Promise<string | null> {
  const { data, error } = await db.storage.from(NOTE_IMAGES_BUCKET).download(storagePath);
  if (error || !data) return null;
  const base64 = Buffer.from(await data.arrayBuffer()).toString("base64");
  return `data:${mime};base64,${base64}`;
}
