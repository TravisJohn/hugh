import { type NextRequest, NextResponse } from "next/server";
import { claudeClient } from "@/lib/claude/client";
import { readCallImage, type CallImage } from "@/lib/claude/imageInput";
import { chargedInputTokens, createImageMessage, textBudgetResponse } from "@/lib/claude/textBudget";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { requireProvisionedApi } from "@/lib/auth/requireProvisioned";
import { logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { createServiceClient } from "@/lib/supabase/service";
import { NOTE_IMAGES_BUCKET } from "@/lib/notes/storage";
import { assertOwnedStoragePaths } from "@/lib/storage/ownership";
import { buildCoachCall, coachImageProblem, type CoachSlice, type CoachThreadMessage } from "@/lib/notes/coachPrompt";
import type { NoteMessage } from "@/types";

export const dynamic = "force-dynamic";
// Vision + a short reply can take a few seconds, and a multi-snip bucket sends
// up to four images; give it headroom.
export const maxDuration = 90;

const anthropic = claudeClient();

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;

// The Coach: Hugh reads ONE screenshot + that screenshot's chat thread and
// appends a correction. Threads are per screenshot, so the Coach's attention is
// scoped to the exact image the learner is looking at. It runs only on an
// explicit "Coach" press.
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

  const body = (await request.json().catch(() => ({}))) as { image_id?: string };
  const imageId = body.image_id?.trim();
  if (!imageId) return NextResponse.json({ error: "image_id required" }, { status: 400 });

  const startedAt = Date.now();

  try {
    const db = createServiceClient();

    // Ownership: resolve the screenshot (and its note) for this user.
    const { data: image, error: imageError } = await db
      .from("note_images").select("note_id, storage_path, mime, parent_image_id")
      .eq("id", imageId).eq("user_id", userId).maybeSingle();
    if (imageError) throw imageError;
    if (!image) return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });
    if (image.parent_image_id) {
      // Only buckets own a thread; a snip is part of one, never a target itself.
      return NextResponse.json({ error: "That's a slice of another screenshot." }, { status: 400 });
    }

    // This screenshot's thread only.
    const { data: msgRows, error: threadError } = await db
      .from("note_messages").select("role, content").eq("user_id", userId).eq("image_id", imageId)
      .order("created_at", { ascending: true });
    if (threadError) throw threadError;
    const thread = (msgRows ?? []) as CoachThreadMessage[];

    // The bucket's own image first, then its snips in stacking order — the same
    // order the learner sees them in the pane.
    const { data: partRows, error: partsError } = await db
      .from("note_images").select("storage_path, mime")
      .eq("user_id", userId).eq("parent_image_id", imageId)
      .order("position", { ascending: true }).order("created_at", { ascending: true });
    if (partsError) throw partsError;
    const paths = [image, ...(partRows ?? [])].map((slice) => slice.storage_path as string);
    assertOwnedStoragePaths(userId, paths);

    // Each slice's bytes go in the request itself, so Claude never has to reach
    // Supabase Storage. Any slice that can't go stops the whole question.
    const slices = await Promise.all(paths.map((path) => readSlice(db, path)));
    const problem = coachImageProblem(slices);
    if (problem) {
      void recordOperation({
        userId, operation: "notes.coach", outcome: problem.outcome,
        durationMs: Date.now() - startedAt, detail: { stage: problem.stage },
      });
      return NextResponse.json({ error: problem.error }, { status: problem.status });
    }
    const images = slices.filter((slice): slice is CallImage => typeof slice !== "string");

    const res = await createImageMessage(
      anthropic, userId, "notes/coach",
      buildCoachCall({ model: MODEL, maxTokens: MAX_TOKENS }, thread, images),
    );
    void logUsage({
      userId,
      model:     MODEL,
      feature:   "notes/coach",
      tokensIn:  chargedInputTokens(res.usage),
      tokensOut: res.usage.output_tokens,
    });

    const first = res.content[0];
    const reply = first?.type === "text" ? first.text.trim() : "";
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
    // The budget gate, an over-long thread, or the plan's own reason (limit
    // reached, signed out) each have a sentence of their own for the learner.
    const refusal = textBudgetResponse(e);
    if (refusal) {
      void recordOperation({
        userId, operation: "notes.coach", outcome: "refused",
        detail: { reason: "text-admission" },
      });
      return refusal;
    }
    console.error("[notes/coach] failed:", e);
    void recordOperation({
      userId, operation: "notes.coach", outcome: "failed",
      durationMs: Date.now() - startedAt, error: e,
    });
    return NextResponse.json({ error: "The Coach ran into a problem. Try again." }, { status: 502 });
  }
}

// Download one slice from Storage and read it as an image Claude will accept.
async function readSlice(
  db: ReturnType<typeof createServiceClient>,
  storagePath: string,
): Promise<CoachSlice> {
  const { data, error } = await db.storage.from(NOTE_IMAGES_BUCKET).download(storagePath);
  if (error || !data) return "unreadable";
  return readCallImage(Buffer.from(await data.arrayBuffer()));
}
