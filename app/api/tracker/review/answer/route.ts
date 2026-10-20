import "server-only";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import {
  parseAnswerRequest, parseStoredQuestions, questionExists, revealFor,
} from "@/lib/tracker/reviewGrading";

// Lock one answer to a stored review quiz, then reveal that question's key.
//
// The order is the point. The key is only sent once an answer is locked, and a
// locked answer cannot be changed — the (quiz_id, question_index) primary key
// refuses a second one (migration 059), which also settles concurrent requests
// for the same question without a read-then-write race. Spends no tokens.

/** Postgres unique_violation: this question already has a locked answer. */
const ALREADY_ANSWERED = "23505";

interface StoredQuizRow {
  id:        string;
  user_id:   string;
  questions: unknown;
}

const FAILED = "Couldn't record that answer. Please try again.";

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const parsed = parseAnswerRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { quizId, questionIndex, choice } = parsed.request;

  // Quizzes have no learner policy, so the service role reads them and the
  // ownership check is this one, explicit and unconditional.
  const db = createServiceClient();
  const { data: quiz, error: quizError } = await db
    .from("review_quizzes")
    .select("id, user_id, questions")
    .eq("id", quizId)
    .maybeSingle<StoredQuizRow>();

  if (quizError) {
    console.error("[review/answer] quiz lookup failed:", quizError.message);
    return NextResponse.json({ error: FAILED }, { status: 500 });
  }
  if (!quiz || quiz.user_id !== userId) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const questions = parseStoredQuestions(quiz.questions);
  if (!questions) {
    console.error(`[review/answer] quiz ${quizId} is stored in a shape that cannot be graded`);
    return NextResponse.json({ error: FAILED }, { status: 500 });
  }
  if (!questionExists(questions, questionIndex)) {
    return NextResponse.json({ error: "This quiz has no such question" }, { status: 400 });
  }

  const { error: lockError } = await db
    .from("review_quiz_answers")
    .insert({ quiz_id: quizId, question_index: questionIndex, choice });

  let locked = choice;
  if (lockError) {
    if (lockError.code !== ALREADY_ANSWERED) {
      console.error("[review/answer] failed to lock answer:", lockError.message);
      return NextResponse.json({ error: FAILED }, { status: 500 });
    }
    // Already answered — a retry after a dropped reply, or a second click.
    // Reveal against the answer that was locked first, never this one.
    const { data: existing, error: existingError } = await db
      .from("review_quiz_answers")
      .select("choice")
      .eq("quiz_id", quizId)
      .eq("question_index", questionIndex)
      .maybeSingle<{ choice: number | null }>();
    if (existingError || !existing) {
      console.error("[review/answer] locked answer could not be read back:", existingError?.message ?? "no row");
      return NextResponse.json({ error: FAILED }, { status: 500 });
    }
    locked = existing.choice;
  }

  return NextResponse.json(revealFor(questions[questionIndex], questionIndex, locked));
}
