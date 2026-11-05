import { type NextRequest, NextResponse } from "next/server";
import { claudeClient } from "@/lib/claude/client";
import { chargedInputTokens, createTextMessage, textBudgetResponse } from "@/lib/claude/textBudget";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { requireProvisionedApi } from "@/lib/auth/requireProvisioned";
import { logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { createServiceClient } from "@/lib/supabase/service";
import { buildSummaryPrompt, type SummaryThreadMessage } from "@/lib/notes/summaryPrompt";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const anthropic = claudeClient();

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-sonnet-4-6";

// The running summary: condense ONE screenshot's thread into revision notes. The
// thread is text-only, so unlike /api/notes/coach it never touches Storage. The
// summary is transient — generated on demand, not persisted — so it always
// reflects the current conversation.

const unauth = () => NextResponse.json({ error: "Not signed in." }, { status: 401 });

// POST /api/notes/summarize { image_id } → { summary: string }
export async function POST(request: NextRequest) {
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

  const body = (await request.json().catch(() => ({}))) as { image_id?: string };
  const imageId = body.image_id?.trim();
  if (!imageId) return NextResponse.json({ error: "image_id required" }, { status: 400 });

  const startedAt = Date.now();

  try {
    const db = createServiceClient();

    // Ownership via the screenshot.
    const { data: image, error: imageError } = await db
      .from("note_images").select("id").eq("id", imageId).eq("user_id", userId).maybeSingle();
    if (imageError) throw imageError;
    if (!image) return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });

    const { data: msgRows, error: threadError } = await db
      .from("note_messages").select("role, content").eq("user_id", userId).eq("image_id", imageId)
      .order("created_at", { ascending: true });
    if (threadError) throw threadError;
    const thread = (msgRows ?? []) as SummaryThreadMessage[];
    if (thread.length === 0) {
      return NextResponse.json(
        { error: "Nothing to summarise yet — add your thoughts or ask the Coach first." },
        { status: 400 },
      );
    }

    const res = await createTextMessage(anthropic, userId, "notes/summarize", {
      model: MODEL,
      max_tokens: 512,
      ...buildSummaryPrompt(thread),
    });
    void logUsage({
      userId,
      model:     MODEL,
      feature:   "notes/summarize",
      tokensIn:  chargedInputTokens(res.usage),
      tokensOut: res.usage.output_tokens,
    });

    const first = res.content[0];
    const summary = first?.type === "text" ? first.text.trim() : "";
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
    const refusal = textBudgetResponse(e);
    if (refusal) {
      void recordOperation({
        userId, operation: "notes.summarize", outcome: "refused",
        detail: { reason: "text-admission" },
      });
      return refusal;
    }
    console.error("[notes/summarize] failed:", e);
    void recordOperation({
      userId, operation: "notes.summarize", outcome: "failed",
      durationMs: Date.now() - startedAt, error: e,
    });
    return NextResponse.json({ error: "The summary ran into a problem. Try again." }, { status: 502 });
  }
}
