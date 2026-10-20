// ── Review quiz: what the server reveals, and how it grades ────────────────
// The quiz used to be graded in the browser. The quiz route sent the answer
// key with the questions, the page compared clicks against it, and on a pass
// the page told the milestone PATCH route to set review_validated — so a
// learner could skip the quiz and send that pass themselves.
//
// Now the key never leaves the server until the learner has committed to an
// answer. The flow, and the rules this module holds for it:
//   1. tracker/review/quiz stores the quiz (migration 059) and sends only
//      `toPublicQuestions` — the question and its four options.
//   2. tracker/review/answer locks one answer per question, then sends back
//      that question's `revealFor` (correct option, explanation, source).
//      Locking first is what makes revealing safe: the key for question 2
//      tells you nothing about question 3, and question 2 is already answered.
//   3. tracker/review/submit grades the locked answers with `gradeQuiz` and,
//      on a pass, records review_validated with the service role.
//
// Pure: no I/O.

import { isWellFormed, MIN_QUESTIONS, MAX_QUESTIONS, type GeneratedQuestion } from "@/lib/tracker/quizSource";

/** What the browser sees before answering. Never the key, the explanation or the source. */
export interface PublicQuestion {
  question: string;
  options:  string[];
}

export function toPublicQuestions(questions: readonly GeneratedQuestion[]): PublicQuestion[] {
  return questions.map(q => ({ question: q.question, options: [...q.options] }));
}

/**
 * Read a stored quiz back. The column is jsonb, so nothing is assumed: a quiz
 * whose questions do not all parse is treated as unusable, never graded on
 * whatever part of it survived.
 */
export function parseStoredQuestions(raw: unknown): GeneratedQuestion[] | null {
  if (!Array.isArray(raw)) return null;
  const items: unknown[] = raw;
  if (items.length < MIN_QUESTIONS || items.length > MAX_QUESTIONS) return null;
  const questions: GeneratedQuestion[] = [];
  for (const q of items) {
    if (!isWellFormed(q)) return null;
    questions.push(q);
  }
  return questions;
}

/** One locked answer, as stored. `choice` null is a question whose timer ran out. */
export interface LockedAnswer {
  question_index: number;
  choice:         number | null;
}

export interface AnswerRequest {
  quizId:        string;
  questionIndex: number;
  choice:        number | null;
}

export type ParsedAnswerRequest =
  | { ok: true; request: AnswerRequest }
  | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checked before any query, so a garbage id is a 400, not a Postgres cast error read as a 500. */
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

function asObject(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

/**
 * Shape-check the answer route's body. Whether the index exists in *this* quiz
 * is checked separately, once the quiz is loaded (`questionExists`).
 */
export function parseAnswerRequest(body: unknown): ParsedAnswerRequest {
  const b = asObject(body);
  if (!b) return { ok: false, error: "Invalid request body" };
  const { quizId, questionIndex, choice } = b;
  if (!isUuid(quizId)) return { ok: false, error: "quizId must be a quiz id" };
  if (typeof questionIndex !== "number" || !Number.isInteger(questionIndex) || questionIndex < 0) {
    return { ok: false, error: "questionIndex must be a whole number" };
  }
  if (choice !== null && (typeof choice !== "number" || !Number.isInteger(choice) || choice < 0 || choice > 3)) {
    return { ok: false, error: "choice must be 0-3, or null when time ran out" };
  }
  return { ok: true, request: { quizId, questionIndex, choice } };
}

export interface SubmitRequest {
  quizId:      string;
  milestoneId: string;
}

/**
 * Shape-check the submit route's body. The milestone is named as well as the
 * quiz so the route can refuse a quiz submitted against a card it was not
 * generated for — the write always uses the stored quiz's own milestone.
 */
export function parseSubmitRequest(body: unknown): { ok: true; request: SubmitRequest } | { ok: false; error: string } {
  const b = asObject(body);
  if (!b) return { ok: false, error: "Invalid request body" };
  if (!isUuid(b.quizId)) return { ok: false, error: "quizId must be a quiz id" };
  if (!isUuid(b.milestoneId)) return { ok: false, error: "milestoneId must be a milestone id" };
  return { ok: true, request: { quizId: b.quizId, milestoneId: b.milestoneId } };
}

export function questionExists(questions: readonly GeneratedQuestion[], index: number): boolean {
  return index >= 0 && index < questions.length;
}

/** What one locked answer earns the learner: the feedback the quiz shows after each question. */
export interface AnswerReveal {
  questionIndex: number;
  /** The answer as locked — which may be an earlier one than this request sent. */
  choice:        number | null;
  correct:       boolean;
  correctIndex:  number;
  explanation:   string;
  source:        string;
}

export function revealFor(question: GeneratedQuestion, questionIndex: number, choice: number | null): AnswerReveal {
  return {
    questionIndex,
    choice,
    correct:      choice !== null && choice === question.correctIndex,
    correctIndex: question.correctIndex,
    explanation:  question.explanation,
    source:       question.source,
  };
}

export interface QuizGrade {
  total:    number;
  correct:  number;
  /** Questions with a locked answer. A question never answered counts as wrong. */
  answered: number;
  /** Every question, however many the notes supported — not a fixed 5. */
  passed:   boolean;
}

/**
 * Grade a quiz from its locked answers.
 *
 * A question with no locked answer is wrong rather than an error: submitting
 * early cannot help, and it must not be a way to make the grade fail open.
 * Answers for indexes the quiz does not have are ignored. A quiz with fewer
 * than MIN_QUESTIONS can never pass — an empty quiz would otherwise be "all
 * correct", and parseStoredQuestions should already have refused it.
 */
export function gradeQuiz(questions: readonly GeneratedQuestion[], answers: readonly LockedAnswer[]): QuizGrade {
  const byIndex = new Map<number, number | null>();
  for (const a of answers) {
    if (questionExists(questions, a.question_index) && !byIndex.has(a.question_index)) {
      byIndex.set(a.question_index, a.choice);
    }
  }

  let correct = 0;
  questions.forEach((q, i) => {
    const choice = byIndex.get(i);
    if (choice !== undefined && choice !== null && choice === q.correctIndex) correct++;
  });

  const total = questions.length;
  return {
    total,
    correct,
    answered: byIndex.size,
    passed:   total >= MIN_QUESTIONS && correct === total,
  };
}

/**
 * What the submit route reports about the milestone write: done, deliberately
 * not done (the quiz was not passed), or passed but not saved. The last needs
 * its own copy on the page — the pass is real even though it was not recorded.
 * Same vocabulary as MasteryRecord, for the same reason.
 */
export type ReviewRecord = "saved" | "skipped" | "failed";

/**
 * The milestone columns a graded quiz writes. A pass validates the review; a
 * fail writes nothing, so a practice retake on a reviewed card never revokes
 * it. Moving the card back into review is what clears the flag.
 */
export function reviewWrite(grade: QuizGrade): { review_validated: true } | null {
  return grade.passed ? { review_validated: true } : null;
}
