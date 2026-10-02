import { type NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { documentUploadEnabled, DOCUMENT_UPLOAD_LOCKED_MESSAGE } from "@/lib/learn/documentPath";
import { createClient } from "@/lib/supabase/server";
import { enforceUsageGate, logUsage } from "@/lib/usage";
import {
  documentTopicExtractionPrompt,
  parseDocumentTopicExtraction,
  type DocumentTopicExtraction,
} from "@/lib/claude/prompts";
import { judgeTopicDomain } from "@/lib/learn/topic-domain-server";
import { awaitsChoice } from "@/lib/learn/topic-domain";
import { logSafeError } from "@/lib/observability/log";
import { recordOperation } from "@/lib/observability/record";
import { writeOutcome } from "@/lib/supabase/writeResult";
import { attemptWithUsage, wasBilled } from "@/lib/claude/attemptWithUsage";
import {
  extractDocumentText,
  EmptyExtractionError,
  UnsupportedDocumentTypeError,
} from "@/lib/documents/extract";
import { ALLOWED_DOCUMENT_MIME, MAX_DOCUMENT_BYTES } from "@/lib/documents/limits";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-sonnet-4-6";

// First half of the document-upload path (PRD-course-from-document.md §7.1):
// upload → extract text → derive a candidate topic → gate it → create the
// goal in 'awaiting_approval' so the learner can review before the second
// half (`approve`) fires actual track generation. Two Claude calls chained
// (topic extraction, then the domain gate) comfortably fit a normal request —
// no after() needed here, unlike generateTrack's milestone build.

/**
 * Extraction has no user context of its own, so it hands the token counts back
 * to the POST handler, which owns the userId and does the logging. Counts
 * accumulate across retries — a discarded attempt still costs money.
 *
 * It used to accumulate them and then `throw`, which lost every one of them on
 * the only path where the total mattered: two Sonnet calls carrying a whole
 * document, billed and unrecorded. Returning an outcome instead of throwing is
 * what makes the counts survive the failure — see lib/claude/attemptWithUsage,
 * where `report` is deliberately called before the parse that can throw.
 */
function extractCandidateTopic(documentText: string) {
  return attemptWithUsage(2, async report => {
    const msg = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 600,
      messages:   [{ role: "user", content: documentTopicExtractionPrompt(documentText) }],
    });
    report({ tokensIn: msg.usage.input_tokens, tokensOut: msg.usage.output_tokens });
    const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
    return parseDocumentTopicExtraction(text);
  });
}

export async function POST(request: NextRequest) {
  // The document path is locked (see lib/learn/documentPath.ts). Refused here
  // rather than only hidden in the UI: this endpoint is reachable directly, and
  // a check that only runs in the browser is not a check.
  if (!documentUploadEnabled()) {
    return NextResponse.json({ error: DOCUMENT_UPLOAD_LOCKED_MESSAGE }, { status: 403 });
  }

  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const usageGate = await enforceUsageGate(userId, "dashboard/document-extract");
  if (usageGate) {
    void recordOperation({
      userId, operation: "track.extract", outcome: "refused",
      detail: { reason: "usage-gate" },
    });
    return usageGate;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }

  const file    = form.get("file");
  const endDate = String(form.get("end_date") ?? "").trim();
  if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
  if (!endDate) return NextResponse.json({ error: "end_date is required" }, { status: 400 });

  if (!ALLOWED_DOCUMENT_MIME[file.type]) {
    return NextResponse.json({ error: "Only PDF, DOCX, or HTML files are supported." }, { status: 415 });
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return NextResponse.json({ error: "File is larger than 15 MB." }, { status: 413 });
  }

  let extracted;
  try {
    extracted = await extractDocumentText(file);
  } catch (err) {
    if (err instanceof EmptyExtractionError) {
      return NextResponse.json(
        { error: "We couldn't find any text in that file — scanned or image-only documents aren't supported yet." },
        { status: 422 },
      );
    }
    if (err instanceof UnsupportedDocumentTypeError) {
      return NextResponse.json({ error: "Only PDF, DOCX, or HTML files are supported." }, { status: 415 });
    }
    logSafeError("goals/document/extract read", err, [file?.name ?? ""]);
    return NextResponse.json({ error: "Couldn't read that file." }, { status: 502 });
  }

  const startedAt  = Date.now();
  const extraction = await extractCandidateTopic(extracted.text);

  // Logged before the outcome is even inspected, and on both branches. Whatever
  // Claude was asked, it has already charged for; which branch we are on
  // changes what the learner sees, not what this cost.
  if (wasBilled(extraction.usage)) {
    void logUsage({
      userId,
      model:     MODEL,
      feature:   "dashboard/document-extract",
      tokensIn:  extraction.usage.tokensIn,
      tokensOut: extraction.usage.tokensOut,
    });
  }

  if (!extraction.ok) {
    logSafeError("goals/document/extract topic", extraction.error, [extracted.text.slice(0, 200), file?.name ?? ""]);
    void recordOperation({
      userId, operation: "track.extract", outcome: "failed",
      durationMs: Date.now() - startedAt, error: extraction.error,
      redact: [extracted.text.slice(0, 200), file?.name ?? ""],
      detail: { attempts: extraction.attempts },
    });
    return NextResponse.json({ error: "Couldn't extract a topic from that document." }, { status: 502 });
  }

  const candidate: DocumentTopicExtraction = extraction.value;
  // Only the file's TYPE is recorded. This route carries learner-supplied
  // documents, so neither the filename nor any extracted text may reach a
  // telemetry row.
  void recordOperation({
    userId, operation: "track.extract", outcome: "ok",
    durationMs: Date.now() - startedAt, detail: { mime: file?.type ?? "unknown" },
  });

  // Domain gate (PRD §6 layer 3), reused in-process — same judge the typed-
  // topic path calls, just with no HTTP round-trip since we're already
  // server-side. Rejected verdicts return the same shape classify-topic
  // does, so any future client code can share one verdict-handling path.
  let verdict;
  try {
    verdict = await judgeTopicDomain(candidate.candidateTopic, userId);
  } catch {
    return NextResponse.json({ error: "Hugh couldn't check this document topic right now. Please try again." }, { status: 503 });
  }
  if (verdict.verdict === "out") {
    return NextResponse.json(verdict);
  }

  // A verdict that holds a choice out to the learner — 'needs_angle' or
  // 'reframe' — deliberately does NOT stop here. Stopping would ask the
  // learner which angle they meant on a screen whose only input is a file
  // picker: a question with no answer box (CLAUDE.md rule 5). It carries into
  // the review step instead, which already has an editable topic field, and
  // `approve` re-gates before a single milestone is generated. The goal sits
  // at 'awaiting_approval' until then, so nothing is built from an unresolved
  // topic.
  //
  // Asked via `awaitsChoice` rather than by naming the verdicts here, so a
  // fifth verdict added later cannot silently fall through this line as
  // though it were approval.
  const gate = awaitsChoice(verdict) ? verdict : null;

  const supabase = await createClient();

  const { data: goal, error: goalError } = await supabase
    .from("learning_goals")
    .insert({
      user_id:      userId,
      topic:        candidate.candidateTopic,
      end_date:     endDate,
      track_status: "awaiting_approval",
      source_kind:  "document",
    })
    .select("*")
    .single();

  if (goalError || !goal) {
    logSafeError("goals/document/extract db", goalError, [candidate.candidateTopic]);
    return NextResponse.json({ error: "Failed to save goal" }, { status: 500 });
  }

  const { error: extractionError } = await supabase
    .from("pending_document_extractions")
    .insert({
      goal_id:        goal.id as string,
      extracted_text: extracted.text,
      tips:           candidate.tips,
      source_format:  extracted.format,
    });

  if (extractionError) {
    logSafeError("goals/document/extract store", extractionError, [candidate.candidateTopic]);

    // Roll back — an 'awaiting_approval' goal with no pending extraction row
    // is a dead end the `approve` route can never complete.
    //
    // The rollback was itself unchecked, which made this comment a hope rather
    // than a guarantee: a delete that fails, or that matches no row, says
    // nothing, and the dead-end goal it was meant to remove survives on the
    // learner's board with no way to finish it. Both outcomes are failures, but
    // they leave the learner in different places, so they do not share a
    // sentence.
    const rolledBack = writeOutcome(
      await supabase
        .from("learning_goals")
        .delete()
        .eq("id", goal.id as string)
        .select("id")
        .single(),
    );

    if (!rolledBack.ok) {
      logSafeError("goals/document/extract rollback", new Error(rolledBack.message), [candidate.candidateTopic]);
      return NextResponse.json(
        {
          error:
            "We couldn't save your document, and couldn't tidy up the half-made goal it left behind. " +
            "It may show on your board as stuck — delete it there and try uploading again.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ error: "Failed to save extracted document." }, { status: 500 });
  }

  return NextResponse.json({
    goal,
    candidateTopic: candidate.candidateTopic,
    tips:           candidate.tips,
    truncated:      extracted.truncated,
    gate,
  });
}
