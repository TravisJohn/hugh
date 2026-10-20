import "server-only";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { recordOperation } from "@/lib/observability/record";
import {
  parseSubmitRequest, parseStoredQuestions, gradeQuiz, reviewWrite,
  type LockedAnswer, type ReviewRecord,
} from "@/lib/tracker/reviewGrading";

// Grade a stored review quiz from its locked answers, and record a pass.
//
// The browser used to grade the quiz and tell the milestone PATCH route the
// card was reviewed. Since migration 058 a learner's session cannot write
// review_validated, and that PATCH path is gone; this route decides the pass
// itself and writes it with the service role.
//
// Safe to call again: the answers are locked, so the grade is the same every
// time, and a pass that failed to save is saved by simply submitting again.
// That is the page's "Try saving again". Spends no tokens.

interface StoredQuizRow {
  id:           string;
  user_id:      string;
  milestone_id: string;
  questions:    unknown;
}

const FAILED = "Couldn't check your answers. Please try again.";

/**
 * Write the pass. A failed write is reported, never thrown: the pass is real,
 * and the page must say it was not saved rather than claim it was.
 */
async function recordReviewResult(milestoneId: string, write: { review_validated: true }): Promise<ReviewRecord> {
  const { error } = await createServiceClient()
    .from("milestones")
    .update(write)
    .eq("id", milestoneId);
  if (error) {
    console.error("[review/submit] Failed to record result:", error.message);
    return "failed";
  }
  return "saved";
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const parsed = parseSubmitRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { quizId, milestoneId } = parsed.request;

  const db = createServiceClient();
  const { data: quiz, error: quizError } = await db
    .from("review_quizzes")
    .select("id, user_id, milestone_id, questions")
    .eq("id", quizId)
    .maybeSingle<StoredQuizRow>();

  if (quizError) {
    console.error("[review/submit] quiz lookup failed:", quizError.message);
    void recordOperation({ userId, operation: "quiz.submit", outcome: "failed", durationMs: Date.now() - startedAt, detail: { stage: "load" } });
    return NextResponse.json({ error: FAILED }, { status: 500 });
  }
  // The quiz route stored it only after checking the learner owns the card, so
  // owning the quiz is owning the card. Naming a different card is refused
  // outright; the write below uses the quiz's own milestone either way.
  if (!quiz || quiz.user_id !== userId || quiz.milestone_id !== milestoneId) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const questions = parseStoredQuestions(quiz.questions);
  if (!questions) {
    console.error(`[review/submit] quiz ${quizId} is stored in a shape that cannot be graded`);
    void recordOperation({ userId, operation: "quiz.submit", outcome: "failed", durationMs: Date.now() - startedAt, detail: { stage: "parse" } });
    return NextResponse.json({ error: FAILED }, { status: 500 });
  }

  const { data: answers, error: answersError } = await db
    .from("review_quiz_answers")
    .select("question_index, choice")
    .eq("quiz_id", quizId)
    .returns<LockedAnswer[]>();

  // Grading on a dropped read would fail a learner who answered everything.
  if (answersError || !answers) {
    console.error("[review/submit] answers lookup failed:", answersError?.message ?? "no rows returned");
    void recordOperation({ userId, operation: "quiz.submit", outcome: "failed", durationMs: Date.now() - startedAt, detail: { stage: "load" } });
    return NextResponse.json({ error: FAILED }, { status: 500 });
  }

  const grade  = gradeQuiz(questions, answers);
  const write  = reviewWrite(grade);
  const record: ReviewRecord = write ? await recordReviewResult(quiz.milestone_id, write) : "skipped";

  void recordOperation({
    userId, operation: "quiz.submit", outcome: record === "failed" ? "failed" : "ok",
    durationMs: Date.now() - startedAt,
    detail: record === "failed"
      ? { passed: grade.passed, record, stage: "record" }
      : { passed: grade.passed, record, questions: grade.total },
  });

  return NextResponse.json({ total: grade.total, correct: grade.correct, passed: grade.passed, record });
}
