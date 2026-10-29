import { type NextRequest, NextResponse } from "next/server";
import { paidServiceOffResponse } from "@/lib/claude/subscription/planResponses";
import OpenAI from "openai";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { requireProvisionedApi } from "@/lib/auth/requireProvisioned";
import { enforceUsageGate, logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { createServiceClient } from "@/lib/supabase/service";
import { buildSummaryMessages, type SummaryThreadMessage } from "@/lib/notes/summaryPrompt";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Summarising an existing thread needs no vision — the cheaper model is enough.
// Kept in one place so the API call and the usage log can never disagree
// about what was billed.
const MODEL = "gpt-4o-mini";

// The running summary: condense ONE screenshot's thread into revision notes. Like
// /api/notes/coach it calls OpenAI (same OPENAI_API_KEY), but the thread is
// text-only so it uses the cheap text model gpt-4o-mini (no vision needed) and
// never touches Storage. The summary is transient — generated on demand, not
// persisted — so it always reflects the current conversation.

const unauth = () => NextResponse.json({ error: "Not signed in." }, { status: 401 });

// POST /api/notes/summarize { image_id } → { summary: string }
export async function POST(request: NextRequest) {
  const off = paidServiceOffResponse("Summarising");
  if (off) return off;

  const userId = await getAuthenticatedUserId(request);
  if (!userId) return unauth();

  // Privacy pass: this surface holds personal material and is off by
  // default (migration 050). RLS stops the browser reaching the tables
  // and bucket directly; this stops our own service-role client, which
  // bypasses RLS entirely.
  const denied = await requireProvisionedApi(userId, "notes");
  if (denied) {
    void recordOperation({
      userId, operation: "notes.summarize", outcome: "refused",
      detail: { reason: "not-provisioned" },
    });
    return denied;
  }

  const usageGate = await enforceUsageGate(userId, "notes/summarize");
  if (usageGate) {
    void recordOperation({
      userId, operation: "notes.summarize", outcome: "refused",
      detail: { reason: "usage-gate" },
    });
    return usageGate;
  }

  const body = (await request.json().catch(() => ({}))) as { image_id?: string };
  const imageId = body.image_id?.trim();
  if (!imageId) return NextResponse.json({ error: "image_id required" }, { status: 400 });

  // Instantiate per request so the build never needs the key; a missing key is a
  // graceful 503, not a crash (mirrors /api/notes/coach).
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Summaries aren't configured on this deployment (missing OPENAI_API_KEY)." },
      { status: 503 },
    );
  }

  const startedAt = Date.now();

  try {
    const db = createServiceClient();

    // Ownership via the screenshot.
    const { data: image } = await db
      .from("note_images").select("id").eq("id", imageId).eq("user_id", userId).maybeSingle();
    if (!image) return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });

    const { data: msgRows } = await db
      .from("note_messages").select("role, content").eq("user_id", userId).eq("image_id", imageId)
      .order("created_at", { ascending: true });
    const thread = (msgRows ?? []) as SummaryThreadMessage[];
    if (thread.length === 0) {
      return NextResponse.json(
        { error: "Nothing to summarise yet — add your thoughts or ask the Coach first." },
        { status: 400 },
      );
    }

    const openai = new OpenAI({ apiKey });
    const res = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 512,
      messages: buildSummaryMessages(thread),
    });
    // OpenAI names these prompt_/completion_tokens, not input_/output_tokens.
    void logUsage({
      userId,
      model:     MODEL,
      feature:   "notes/summarize",
      tokensIn:  res.usage?.prompt_tokens     ?? 0,
      tokensOut: res.usage?.completion_tokens ?? 0,
    });
    const summary = res.choices[0]?.message?.content?.trim();
    if (!summary) {
      // Billed and empty — logUsage above already charged for this attempt.
      void recordOperation({
        userId, operation: "notes.summarize", outcome: "failed",
        durationMs: Date.now() - startedAt, detail: { stage: "empty-reply" },
      });
      return NextResponse.json({ error: "Couldn't summarise just now. Try again." }, { status: 502 });
    }

    void recordOperation({
      userId, operation: "notes.summarize", outcome: "ok",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ summary });
  } catch (e) {
    console.error("[notes/summarize] failed:", e);
    void recordOperation({
      userId, operation: "notes.summarize", outcome: "failed",
      durationMs: Date.now() - startedAt, error: e,
    });
    return NextResponse.json({ error: "The summary ran into a problem. Try again." }, { status: 502 });
  }
}
