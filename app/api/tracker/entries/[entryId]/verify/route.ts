import { type NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { factCheckEntryPrompt, parseClaudeJson } from "@/lib/claude/prompts";
import { checkUsageAllowed, logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { logSafeError } from "@/lib/observability/log";
import { writeOutcome } from "@/lib/supabase/writeResult";
import { cardGrounding, renderCardSyllabus } from "@/lib/packs/grounding";
import { groundingRefusalResponse } from "@/lib/packs/cardAccess";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-sonnet-4-6";

interface FactCheckResult {
  status:     "correct" | "incorrect";
  correction: string | null;
  gap:        string | null;
}

/**
 * Auto fact-check a single diary entry against its milestone's goal.
 * On "incorrect": persists the suggested correction and a permanent gap note,
 * leaving the lingering warning (corrected = false). On "correct": clears the
 * warning (corrected = true) but PRESERVES any existing gap note as a record.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ entryId: string }> }
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { allowed } = await checkUsageAllowed(userId, "tracker/verify");
  if (!allowed) {
    // Soft-fail: don't block the learner from writing, just skip the check.
    return NextResponse.json({ skipped: true });
  }

  const { entryId } = await params;
  const supabase = await createClient();

  const { data: entry } = await supabase
    .from("milestone_entries")
    .select("id, body, milestone_id, gap_note")
    .eq("id", entryId)
    .eq("user_id", userId)
    .single();

  if (!entry) return NextResponse.json({ error: "Entry not found" }, { status: 404 });

  // Resolve milestone title + track topic for grounding
  const { data: milestone } = await supabase
    .from("milestones")
    .select("title, concept_ids, tracks!track_id!inner(topic_description)")
    .eq("id", entry.milestone_id)
    .single();

  // A course card's note is judged against its syllabus, not the model's
  // general knowledge (PRD-narrow-learn.md, row 4). A course card whose pack
  // can't be taught is refused in its own words, not checked ungrounded.
  const grounding = cardGrounding((milestone?.concept_ids as string[] | null | undefined) ?? null);
  if (grounding.kind === "refused") {
    return groundingRefusalResponse(grounding.reason);
  }
  const course = grounding.kind === "ok" ? grounding.ground : null;

  const title = (milestone?.title as string) ?? "this topic";
  const topic = course?.subject
    ?? (milestone?.tracks as { topic_description?: string } | null)?.topic_description ?? title;
  const syllabus = course ? renderCardSyllabus(course) : undefined;

  const startedAt = Date.now();

  try {
    const res = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 700,
      messages:   [{ role: "user", content: factCheckEntryPrompt(topic, title, entry.body as string, syllabus) }],
    });

    // Logged before the parse below, which can throw on a malformed reply.
    // The fact-check has already been billed for by the time we look at it.
    void logUsage({ userId, model: MODEL, feature: "tracker/verify", tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens });

    const raw    = res.content[0]?.type === "text" ? res.content[0].text : "{}";
    const parsed = parseClaudeJson<FactCheckResult>(raw);
    const isWrong = parsed.status === "incorrect";

    const update: {
      fact_status: "correct" | "incorrect";
      correction:  string | null;
      corrected:   boolean;
      gap_note?:   string | null;
    } = isWrong
      ? { fact_status: "incorrect", correction: parsed.correction ?? null, corrected: false, gap_note: parsed.gap ?? null }
      : { fact_status: "correct",   correction: null,                       corrected: true };
      // On "correct" we omit gap_note so the existing permanent record is preserved.

    // Item 3's rule, in a route item 3 did not name: this write's reply was
    // discarded, so a verdict that never reached the database still came back
    // as a 200 with an entry the drawer would then render as verified. Only a
    // verified line may be quoted by a review quiz, so a phantom verdict here
    // becomes a quiz question tomorrow.
    const written = await supabase
      .from("milestone_entries")
      .update(update)
      .eq("id", entryId)
      .eq("user_id", userId)
      .select("*")
      .single();

    const stored = writeOutcome(written);
    if (!stored.ok) {
      logSafeError("tracker/verify store", new Error(stored.message), [topic, title]);
      void recordOperation({
        userId, operation: "ask.verify", outcome: "failed",
        durationMs: Date.now() - startedAt, detail: { stage: "store", reason: stored.reason },
      });
      return NextResponse.json({ error: "Couldn't save the fact-check for this entry." }, { status: 500 });
    }

    // The verdict is recorded, never the entry: only a verified line may be
    // quoted by a review quiz, so the ratio here is worth watching.
    void recordOperation({
      userId, operation: "ask.verify", outcome: "ok",
      durationMs: Date.now() - startedAt, detail: { verdict: parsed.status },
    });
    return NextResponse.json({ entry: written.data });
  } catch (err) {
    console.error("[tracker/verify] error:", err);
    void recordOperation({
      userId, operation: "ask.verify", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err, redact: [topic, title],
    });
    return NextResponse.json({ error: "Failed to verify entry" }, { status: 502 });
  }
}
