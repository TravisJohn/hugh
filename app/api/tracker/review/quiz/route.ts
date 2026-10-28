import "server-only";
import { type NextRequest, NextResponse } from "next/server";
import { recordOperation } from "@/lib/observability/record";
import { claudeClient } from "@/lib/claude/client";
import { planFailureResponse } from "@/lib/claude/subscription/planResponses";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { checkUsageAllowed, logUsage } from "@/lib/usage";
import { messageForDenial, statusForDenial } from "@/lib/tokenBudget";
import {
  buildEntriesText, sourceCharCount, questionTarget, keepGroundedQuestions, keepSyllabusQuestions,
  MIN_QUESTIONS, type DiaryEntry,
} from "@/lib/tracker/quizSource";
import { cardGrounding, cardKeyPointRefs, GROUNDING_REFUSAL_MESSAGE, renderCardSyllabus } from "@/lib/packs/grounding";
import { toPublicQuestions } from "@/lib/tracker/reviewGrading";

const anthropic = claudeClient();

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-sonnet-4-6";

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Kept on checkUsageAllowed rather than enforceUsageGate because the refusal
  // has to be recorded before the response goes out — `operation_events` counts
  // a refusal as the system working correctly, not as a failure (047).
  const { allowed, reason, retryAfter } = await checkUsageAllowed(userId, "review/quiz");
  if (!allowed) {
    void recordOperation({
      userId, operation: "quiz.generate", outcome: "refused",
      detail: { reason: reason ?? "usage-gate" },
    });
    return NextResponse.json(
      { error: messageForDenial(reason), retryAfter },
      {
        status:  statusForDenial(reason),
        headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
      },
    );
  }

  const body = (await request.json()) as { milestoneId?: string };
  if (!body.milestoneId) {
    return NextResponse.json({ error: "milestoneId is required" }, { status: 400 });
  }

  const supabase = await createClient();

  // Ownership: RLS already scopes this read, but the check is asserted here too
  // rather than left implicit — a quiz is generated from private notes.
  const { data: milestone, error: milestoneError } = await supabase
    .from("milestones")
    .select("id, title, concept_ids, tracks!track_id!inner(user_id)")
    .eq("id", body.milestoneId)
    .maybeSingle<{ id: string; title: string; concept_ids: string[] | null; tracks: { user_id: string } }>();

  // A failed read is not a missing card (rule 5): say it broke, don't say 404.
  if (milestoneError) {
    console.error("[review/quiz] milestone lookup failed:", milestoneError.message);
    return NextResponse.json({ error: "Failed to generate quiz. Please try again." }, { status: 500 });
  }
  if (!milestone || milestone.tracks?.user_id !== userId) {
    return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
  }

  // A course card's quiz also answers to its syllabus (PRD-narrow-learn.md,
  // row 4). A course card whose pack can't be taught is refused in its own
  // words, never quizzed ungrounded.
  const grounding = cardGrounding(milestone.concept_ids);
  if (grounding.kind === "refused") {
    return NextResponse.json({ error: GROUNDING_REFUSAL_MESSAGE[grounding.reason] }, { status: 503 });
  }
  const course = grounding.kind === "ok" ? grounding.ground : null;

  // Archived entries are hidden from the learner's diary, so they must not be
  // quizzed either — otherwise the quiz asks about notes they cannot re-read.
  // `covered` is what the session actually established; `body` is the narrative
  // fallback for entries written before migration 035 or written by hand.
  const { data: entries, error: entriesError } = await supabase
    .from("milestone_entries")
    .select("title, body, covered")
    .eq("milestone_id", body.milestoneId)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .returns<DiaryEntry[]>();

  // Without this, a dropped read became "you have no diary entries".
  if (entriesError) {
    console.error("[review/quiz] diary lookup failed:", entriesError.message);
    return NextResponse.json({ error: "Failed to generate quiz. Please try again." }, { status: 500 });
  }

  if (!entries || entries.length === 0) {
    return NextResponse.json(
      { error: "No learning diary entries found. Add entries before starting the review quiz." },
      { status: 422 }
    );
  }

  const entriesText = buildEntriesText(entries);
  const target      = questionTarget(sourceCharCount(entries));

  // Note what is deliberately absent: the milestone title. Naming the subject
  // gave the model a topic to generate from when the notes ran thin, which is
  // exactly how questions about undiscussed material got in.
  // A course card adds its syllabus: the answer must agree with it, each
  // question names the key point it tests, and wrong options may be drawn
  // from the card's listed wrong beliefs. The notes rule is unchanged.
  const courseBlock = course ? `

This card belongs to a course with a source-checked syllabus:

${renderCardSyllabus(course)}

Course rules:
- Each question must test one of this card's key points, and the correct answer must agree with it. Set "keyPoint" to that key point's ref, e.g. "${cardKeyPointRefs(course)[0]}". A question that tests nothing in the syllabus is discarded.
- Wrong options may restate the syllabus's listed wrong beliefs; that is the one thing an option may contain that the notes do not.` : "";

  const prompt = `A learner wrote the notes below while studying. They are the ONLY material you may draw on.

${entriesText}
${courseBlock}

Write ${target} multiple-choice question${target === 1 ? "" : "s"} checking whether the learner understood what their own notes say.

Hard rules:
- Draw ONLY on the notes above. If a fact is not in the notes it must not appear in a question, an option, or an explanation — not even standard textbook knowledge of the subject.
- "source" must be a phrase or sentence copied VERBATIM from the notes that makes the correct answer true. It is checked against the notes automatically; a question whose source is not found there is discarded.
- Test understanding of what the notes claim, not recall of their exact wording.
- Exactly 4 options, exactly one correct.
- Give a 1-2 sentence explanation of why the correct answer is right, drawn from the notes.
- If the notes genuinely support fewer than ${target} questions, return fewer. Returning fewer is correct; inventing material is not.

Return ONLY a valid JSON array — no markdown, no commentary:
[
  {
    "question": "...",
    "options": ["Option text A", "Option text B", "Option text C", "Option text D"],
    "correctIndex": 0,
    "explanation": "...",
    "source": "verbatim phrase from the notes"${course ? `,
    "keyPoint": "conceptId:n"` : ""}
  }
]`;

  try {
    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 3072,
      messages:   [{ role: "user", content: prompt }],
    });

    // Logged here, before anything reads the reply. Claude billed the moment
    // it answered, and both lines below can throw — a non-text block, or JSON
    // that will not parse. Logging after them meant a garbled answer was money
    // spent with no record of it anywhere.
    void logUsage({ userId, model: MODEL, feature: "review/quiz", tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens });

    const block = response.content[0];
    if (block.type !== "text") throw new Error("Non-text response from Claude");

    const raw    = block.text.trim().replace(/^```(?:json)?\n?|\n?```$/g, "").trim();
    const parsed = JSON.parse(raw) as unknown;

    const grounded = keepGroundedQuestions(parsed, entriesText, target);
    const { malformed, ungrounded } = grounded;
    const { kept, offSyllabus } = course
      ? keepSyllabusQuestions(grounded.kept, cardKeyPointRefs(course))
      : { kept: grounded.kept, offSyllabus: 0 };

    if (malformed || ungrounded || offSyllabus) {
      console.warn(
        `[review/quiz] milestone=${body.milestoneId} target=${target} kept=${kept.length} ` +
        `malformed=${malformed} ungrounded=${ungrounded} offSyllabus=${offSyllabus}`
      );
    }

    // Better to say the notes are too thin than to quiz someone on material
    // they never covered — that was the original complaint.
    if (kept.length < MIN_QUESTIONS) {
      // 'refused', not 'failed'. Declining to quiz someone on material they
      // never covered is the feature working as designed - that refusal was
      // the whole point of grounding quizzes in the diary.
      void recordOperation({
        userId, operation: "quiz.generate", outcome: "refused",
        durationMs: Date.now() - startedAt,
        detail: { reason: "insufficient_material", kept: kept.length },
      });
      return NextResponse.json(
        {
          error:
            "There isn't enough in your notes for this card to build a fair quiz yet. " +
            "Add another learning session or a diary entry, then try again.",
          code: "insufficient_material",
        },
        { status: 422 }
      );
    }

    // The quiz is stored WITH its answer key, and only the questions go to the
    // browser. The key comes back one question at a time, after the learner
    // has locked an answer (tracker/review/answer), and the pass is decided
    // and recorded by tracker/review/submit. No learner policy exists on this
    // table (059), so the write is the service role's.
    const { data: stored, error: storeError } = await createServiceClient()
      .from("review_quizzes")
      .insert({ user_id: userId, milestone_id: milestone.id, questions: kept })
      .select("id")
      .single<{ id: string }>();

    if (storeError || !stored) {
      console.error("[review/quiz] Failed to store quiz:", storeError?.message ?? "no row returned");
      void recordOperation({
        userId, operation: "quiz.generate", outcome: "failed",
        durationMs: Date.now() - startedAt, detail: { stage: "store" },
      });
      return NextResponse.json({ error: "Failed to generate quiz. Please try again." }, { status: 500 });
    }

    void recordOperation({
      userId, operation: "quiz.generate", outcome: "ok",
      durationMs: Date.now() - startedAt, detail: { questions: kept.length },
    });
    return NextResponse.json({ quizId: stored.id, questions: toPublicQuestions(kept) });
  } catch (err) {
    const planFailure = planFailureResponse(err);
    if (planFailure) return planFailure;
    console.error("[review/quiz] Generation failed:", err);
    void recordOperation({
      userId, operation: "quiz.generate", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err,
    });
    return NextResponse.json({ error: "Failed to generate quiz. Please try again." }, { status: 500 });
  }
}
