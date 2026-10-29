import { cardGrounding, criteriaSyllabus, GROUNDING_REFUSAL_MESSAGE } from "@/lib/packs/grounding";
import { type NextRequest, NextResponse } from "next/server";
import { recordOperation } from "@/lib/observability/record";
import { claudeClient } from "@/lib/claude/client";
import { planFailureResponse } from "@/lib/claude/subscription/planResponses";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { enforceUsageGate, logUsage } from "@/lib/usage";
import type { LearningPoint, MasteryEndReason, MasteryTranscriptTurn } from "@/types";
import {
  buildCriteria,
  renderCriteriaForPrompt,
  prepareDiaryContext,
} from "@/lib/mastery/criteria";
import { buildEvaluationPrompt } from "@/lib/mastery/masteryInstructions";
import { parseMasteryResult } from "@/lib/mastery/result";
import { MAX_DIARY_CHARS } from "@/lib/mastery/realtimeConfig";

export const dynamic = "force-dynamic";

// Grounded final evaluation. The Realtime coach NEVER scores — this route is the
// only scorer. It re-derives the AUTHORITATIVE criteria server-side (never trusts
// the client for them), runs Sonnet, and schema-validates the output before
// returning it. Malformed model output is rejected, never persisted.

const anthropic = claudeClient();

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-sonnet-4-6";

const VALID_END_REASONS: ReadonlySet<string> = new Set<MasteryEndReason>([
  "coach_concluded", "max_followups", "max_duration", "inactivity", "user_ended",
]);

const MAX_TURNS = 40;          // guard against an oversized transcript payload
const MAX_TURN_CHARS = 4_000;  // per-turn cap

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
  const startedAt = Date.now();

  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const usageGate = await enforceUsageGate(userId, "mastery/evaluate");
  if (usageGate) return usageGate;

  const body = (await request.json()) as {
    milestoneId?: string;
    transcript?:  unknown;
    endReason?:   string;
  };

  const { milestoneId } = body;
  if (!milestoneId) {
    return NextResponse.json({ error: "milestoneId is required" }, { status: 400 });
  }

  const endReason: MasteryEndReason =
    body.endReason && VALID_END_REASONS.has(body.endReason)
      ? (body.endReason as MasteryEndReason)
      : "user_ended";

  const transcript = sanitizeTranscript(body.transcript);
  if (transcript.filter((t) => t.role === "learner").length === 0) {
    // No learner speech captured → nothing to ground a score on.
    return NextResponse.json({ error: "No learner responses to evaluate." }, { status: 422 });
  }

  const supabase = await createClient();

  // Ownership + authoritative card content, server-side.
  const { data: milestone } = await supabase
    .from("milestones")
    .select("id, title, summary, learning_points, concept_ids, tracks!track_id!inner(user_id)")
    .eq("id", milestoneId)
    .single();

  if (!milestone) {
    return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
  }

  const { data: entries } = await supabase
    .from("milestone_entries")
    .select("title, body")
    .eq("milestone_id", milestoneId)
    .order("created_at", { ascending: true });

  // A course card is scored against its syllabus, never the learner-editable
  // learning points (PRD-narrow-learn.md, row 4).
  const grounding = cardGrounding((milestone as { concept_ids?: string[] | null }).concept_ids);
  if (grounding.kind === "refused") {
    return NextResponse.json({ error: GROUNDING_REFUSAL_MESSAGE[grounding.reason] }, { status: 503 });
  }
  const criteria = buildCriteria({
    title:          (milestone as { title: string }).title,
    summary:        (milestone as { summary?: string | null }).summary ?? null,
    learningPoints: ((milestone as { learning_points?: LearningPoint[] | null }).learning_points) ?? null,
  }, grounding.kind === "ok" ? criteriaSyllabus(grounding.ground) : undefined);

  const prompt = buildEvaluationPrompt({
    criteriaText: renderCriteriaForPrompt(criteria),
    diaryContext: prepareDiaryContext(entries ?? [], MAX_DIARY_CHARS),
    transcript,
    endReason,
  });

  let raw: string;
  try {
    const completion = await anthropic.messages.create({
      model:      MODEL, // grounded scoring — quality matters
      max_tokens: 700,
      messages:   [{ role: "user", content: prompt }],
    });
    raw = completion.content[0].type === "text" ? completion.content[0].text : "";
    void logUsage({
      userId,
      model:     MODEL,
      feature:   "mastery/evaluate",
      tokensIn:  completion.usage.input_tokens,
      tokensOut: completion.usage.output_tokens,
    });
  } catch (err) {
    const planFailure = planFailureResponse(err);
    if (planFailure) return planFailure;
    console.error("[mastery/evaluate] Anthropic error:", err);
    void recordOperation({
      userId, operation: "mastery.evaluate", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err, detail: { stage: "model" },
    });
    return NextResponse.json({ error: "Failed to evaluate the session." }, { status: 502 });
  }

  const result = parseMasteryResult(raw);
  if (!result) {
    console.error("[mastery/evaluate] malformed model output:", raw.slice(0, 500));
    // A failure, not a refusal: the learner did their part and got nothing.
    void recordOperation({
      userId, operation: "mastery.evaluate", outcome: "failed",
      durationMs: Date.now() - startedAt,
      error: Object.assign(new Error("model output failed schema validation"), { name: "MalformedEvaluation" }),
      detail: { stage: "parse" },
    });
    return NextResponse.json({ error: "Could not produce a valid evaluation." }, { status: 502 });
  }

  void recordOperation({
    userId, operation: "mastery.evaluate", outcome: "ok",
    durationMs: Date.now() - startedAt,
  });
  return NextResponse.json({ result });
}
