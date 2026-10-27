import { type NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { masterySummaryPrompt } from "@/lib/claude/prompts";
import { enforceUsageGate, logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { logSafeError } from "@/lib/observability/log";
import { writeOutcome } from "@/lib/supabase/writeResult";
import { normalizeCoverage } from "@/utils/coverage";
import { readOnlyRefusal } from "@/lib/packs/cardAccess";
import { type LearningPoint } from "@/types";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-sonnet-4-6";

interface MilestoneRow {
  id:                string;
  title:             string;
  summary:           string;
  kanban_column:     string;
  learning_points:   LearningPoint[] | null;
  concept_ids:       string[] | null;
  coverage:          unknown; // legacy or current shape — normalized on read
  mastery_score:     number | null;
  mastery_feedback:  string | null;
  tracks:            { user_id: string; topic_description: string } | null;
}

// POST: (re)generate the mastery "what you learned" summary document for a
// mastered milestone, store it, and return it. Auto-called on first mastery and
// from the drawer's Regenerate button.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("milestones")
    .select("id, title, summary, kanban_column, learning_points, concept_ids, coverage, mastery_score, mastery_feedback, tracks!track_id!inner(user_id, topic_description)")
    .eq("id", id)
    .single();

  const ms = data as unknown as MilestoneRow | null;
  if (!ms || ms.tracks?.user_id !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // An earlier topic is read-only (narrow Learn PR D), so no new summary.
  const readOnly = readOnlyRefusal(ms.concept_ids);
  if (readOnly) return readOnly;
  if (ms.kanban_column !== "done") {
    return NextResponse.json({ error: "Milestone is not mastered" }, { status: 409 });
  }

  // Reserved only once the card qualifies: a refusal above would otherwise
  // leave a reservation behind until it expired.
  const usageGate = await enforceUsageGate(userId, "tracker/summary");
  if (usageGate) {
    void recordOperation({
      userId, operation: "track.summary", outcome: "refused",
      detail: { reason: "usage-gate" },
    });
    return usageGate;
  }

  // Gather the learner's diary entries (with any noted gaps) for this milestone.
  const { data: entries } = await supabase
    .from("milestone_entries")
    .select("title, body, gap_note")
    .eq("milestone_id", id)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (!entries || entries.length === 0) {
    return NextResponse.json({ error: "Add a diary entry before generating a summary" }, { status: 422 });
  }

  // "Covered" for the summary means the learner marked it understood; bookmarked
  // and still-stuck points are treated as not yet covered so the summary can flag them.
  const statuses = normalizeCoverage(ms.coverage)?.statuses ?? {};
  const points = (ms.learning_points ?? []).map(p => ({ text: p.text, covered: statuses[p.id] === "understood" }));
  const diaryEntries = entries.map(e => ({
    title: (e.title as string | null) ?? null,
    body:  e.body as string,
    gap:   (e.gap_note as string | null) ?? null,
  }));

  const prompt = masterySummaryPrompt({
    topic:            ms.tracks?.topic_description ?? ms.title,
    milestoneTitle:   ms.title,
    milestoneSummary: ms.summary,
    points,
    diaryEntries,
    masteryScore:     ms.mastery_score,
    masteryFeedback:  ms.mastery_feedback,
  });

  const startedAt = Date.now();

  try {
    const res = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      messages:   [{ role: "user", content: prompt }],
    });

    const doc = (res.content[0]?.type === "text" ? res.content[0].text : "").trim();
    if (!doc) {
      void recordOperation({
        userId, operation: "track.summary", outcome: "failed",
        durationMs: Date.now() - startedAt, detail: { stage: "empty-doc" },
      });
      return NextResponse.json({ error: "Empty summary generated" }, { status: 502 });
    }

    // Log the spend before touching the database. Claude has already billed
    // for this document, so the cost is real whatever happens to it next — and
    // the store below can now end this request early, which would otherwise
    // have skipped the log and hidden money that was genuinely spent.
    void logUsage({ userId, model: MODEL, feature: "tracker/summary", tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens });

    const generatedAt = new Date().toISOString();
    const stored = writeOutcome(
      await supabase
        .from("milestones")
        .update({ summary_doc: doc, summary_doc_at: generatedAt })
        .eq("id", id)
        .select("id")
        .single(),
    );

    if (!stored.ok) {
      logSafeError("tracker/summary store", new Error(stored.message), [ms.title]);
      // The health page hears the truth: this operation did not succeed. It
      // used to be told "ok" regardless, which is how a dashboard ends up
      // reporting a feature as working while nothing is being stored.
      void recordOperation({
        userId, operation: "track.summary", outcome: "failed",
        durationMs: Date.now() - startedAt, detail: { stage: "store", reason: stored.reason },
      });
      // The learner still gets the document. It was paid for, it is finished,
      // and discarding it would charge them a second time for the same words.
      // `saved: false` is the honest half: the panel shows it, says it will not
      // be here next time, and offers to store it again without regenerating.
      return NextResponse.json({ summaryDoc: doc, generatedAt, saved: false });
    }

    void recordOperation({
      userId, operation: "track.summary", outcome: "ok",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ summaryDoc: doc, generatedAt, saved: true });
  } catch (err) {
    console.error("[tracker/summary] error:", err);
    void recordOperation({
      userId, operation: "track.summary", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err, redact: [ms.title],
    });
    return NextResponse.json({ error: "Failed to generate summary" }, { status: 502 });
  }
}

// PUT: persist a learner-EDITED summary document (Phase 30 — the Guided Reflection
// panel lets the learner hand-edit the summary when they spot a gap). No LLM call;
// this simply saves the provided markdown as the new summary_doc.
const MAX_SUMMARY_CHARS = 20_000;

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { summaryDoc?: unknown };
  const doc = typeof body.summaryDoc === "string" ? body.summaryDoc.trim() : "";

  if (!doc) {
    return NextResponse.json({ error: "summaryDoc is required" }, { status: 400 });
  }
  if (doc.length > MAX_SUMMARY_CHARS) {
    return NextResponse.json({ error: "Summary is too long" }, { status: 413 });
  }

  const supabase = await createClient();

  // Ownership check via the parent track.
  const { data: ms } = await supabase
    .from("milestones")
    .select("id, concept_ids, tracks!track_id!inner(user_id)")
    .eq("id", id)
    .single();

  const card  = ms as unknown as { concept_ids?: string[] | null; tracks?: { user_id: string } } | null;
  const owner = card?.tracks?.user_id;
  if (!ms || owner !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const readOnly = readOnlyRefusal(card?.concept_ids);
  if (readOnly) return readOnly;

  const generatedAt = new Date().toISOString();
  // Checked the same way as the POST above. This path already read its error,
  // but an error was never the whole answer: an update matching no rows reports
  // nothing at all, and this is the route the panel retries against when a
  // generated summary could not be stored. A silent no-op here would tell the
  // learner their rescue worked.
  const stored = writeOutcome(
    await supabase
      .from("milestones")
      .update({ summary_doc: doc, summary_doc_at: generatedAt })
      .eq("id", id)
      .select("id")
      .single(),
  );

  if (!stored.ok) {
    logSafeError("tracker/summary PUT", new Error(stored.message));
    return NextResponse.json({ error: "Failed to save summary" }, { status: 500 });
  }

  return NextResponse.json({ summaryDoc: doc, generatedAt });
}
