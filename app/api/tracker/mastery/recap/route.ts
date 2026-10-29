import { type NextRequest, NextResponse } from "next/server";
import { claudeClient } from "@/lib/claude/client";
import { planFailureResponse } from "@/lib/claude/subscription/planResponses";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { enforceUsageGate, logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import type { MasteryTranscriptTurn } from "@/types";
import { masteryRecapPrompt } from "@/lib/claude/prompts";

export const dynamic = "force-dynamic";

// Guided Reflection recap (Phase 30 — UNMARKED). After an ungraded reflection
// conversation, Hugh writes a short, warm recap of what the learner talked
// through. There is NO score and NO pass/fail — this route never touches
// mastery_validated or mastery_score. Cheap route → Haiku.

const anthropic = claudeClient();

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-haiku-4-5";

const MAX_TURNS = 40;
const MAX_TURN_CHARS = 4_000;

function sanitizeTranscript(input: unknown): MasteryTranscriptTurn[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((t): t is { role: unknown; text: unknown } => typeof t === "object" && t !== null)
    .map((t) => ({
      role: t.role === "coach" ? ("coach" as const) : ("learner" as const),
      text: typeof t.text === "string" ? t.text.slice(0, MAX_TURN_CHARS) : "",
    }))
    .filter((t) => t.text.trim().length > 0)
    .slice(0, MAX_TURNS);
}

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const usageGate = await enforceUsageGate(userId, "mastery/recap");
  if (usageGate) {
    void recordOperation({
      userId, operation: "mastery.recap", outcome: "refused",
      detail: { reason: "usage-gate" },
    });
    return usageGate;
  }

  const body = (await request.json()) as { milestoneId?: string; transcript?: unknown };
  const { milestoneId } = body;
  if (!milestoneId) {
    return NextResponse.json({ error: "milestoneId is required" }, { status: 400 });
  }

  const transcript = sanitizeTranscript(body.transcript);

  const supabase = await createClient();

  // Ownership + title for the recap prompt.
  const { data: milestone } = await supabase
    .from("milestones")
    .select("id, title, tracks!track_id!inner(user_id)")
    .eq("id", milestoneId)
    .single();

  const owner = (milestone as unknown as { tracks?: { user_id: string } } | null)?.tracks?.user_id;
  if (!milestone || owner !== userId) {
    return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
  }

  const prompt = masteryRecapPrompt({
    milestoneTitle: (milestone as { title: string }).title,
    transcript,
  });

  const startedAt = Date.now();

  try {
    const completion = await anthropic.messages.create({
      model:      MODEL, // short, low-stakes generation
      max_tokens: 300,
      messages:   [{ role: "user", content: prompt }],
    });
    const recap = completion.content[0]?.type === "text" ? completion.content[0].text.trim() : "";
    void logUsage({
      userId,
      model:     MODEL,
      feature:   "mastery/recap",
      tokensIn:  completion.usage.input_tokens,
      tokensOut: completion.usage.output_tokens,
    });

    if (!recap) {
      // Billed and empty — logUsage above already charged for this attempt.
      void recordOperation({
        userId, operation: "mastery.recap", outcome: "failed",
        durationMs: Date.now() - startedAt, detail: { stage: "empty-recap" },
      });
      return NextResponse.json({ error: "Could not produce a recap." }, { status: 502 });
    }
    void recordOperation({
      userId, operation: "mastery.recap", outcome: "ok",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ recap });
  } catch (err) {
    const planFailure = planFailureResponse(err);
    if (planFailure) return planFailure;
    console.error("[mastery/recap] Anthropic error:", err);
    void recordOperation({
      userId, operation: "mastery.recap", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err,
    });
    return NextResponse.json({ error: "Failed to write the recap." }, { status: 502 });
  }
}
