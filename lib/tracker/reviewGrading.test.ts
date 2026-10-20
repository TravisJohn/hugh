import { describe, it, expect } from "vitest";
import {
  toPublicQuestions, parseStoredQuestions, parseAnswerRequest, parseSubmitRequest,
  questionExists, revealFor, gradeQuiz, reviewWrite,
} from "./reviewGrading";
import type { GeneratedQuestion } from "./quizSource";

const q = (correctIndex: number, n = 1): GeneratedQuestion => ({
  question:     `Question ${n}?`,
  options:      ["A", "B", "C", "D"],
  correctIndex,
  explanation:  `Because ${n}.`,
  source:       `a verbatim line from note ${n}`,
});
const quiz = [q(0, 1), q(2, 2), q(3, 3)];
const QZ   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARD = "11111111-1111-4111-8111-111111111111";

describe("toPublicQuestions: what the browser may see before it answers", () => {
  it("sends the question and its options and nothing that gives the answer away", () => {
    expect(toPublicQuestions(quiz)[1]).toEqual({ question: "Question 2?", options: ["A", "B", "C", "D"] });
    for (const p of toPublicQuestions(quiz)) {
      expect(Object.keys(p).sort()).toEqual(["options", "question"]);
    }
  });
});

describe("parseStoredQuestions: a stored quiz is graded whole or not at all", () => {
  it("reads back a quiz the quiz route stored", () => {
    expect(parseStoredQuestions(JSON.parse(JSON.stringify(quiz)))).toEqual(quiz);
  });

  it("refuses a quiz with one malformed question rather than grading the rest", () => {
    expect(parseStoredQuestions([q(0), { ...q(1), correctIndex: 7 }])).toBeNull();
  });

  it.each([[[]], [[q(0)]], [[q(0), q(0), q(0), q(0), q(0), q(0)]], [{}], [null]])(
    "refuses %j, which no quiz route could have stored",
    raw => expect(parseStoredQuestions(raw)).toBeNull(),
  );
});

describe("parseAnswerRequest: the answer route's body", () => {
  it("accepts a choice", () => {
    expect(parseAnswerRequest({ quizId: QZ, questionIndex: 1, choice: 3 }))
      .toEqual({ ok: true, request: { quizId: QZ, questionIndex: 1, choice: 3 } });
  });

  it("accepts null, which is how a question whose timer ran out is answered", () => {
    expect(parseAnswerRequest({ quizId: QZ, questionIndex: 0, choice: null }))
      .toEqual({ ok: true, request: { quizId: QZ, questionIndex: 0, choice: null } });
  });

  it.each([
    [{ questionIndex: 0, choice: 0 }, "quizId must be a quiz id"],
    [{ quizId: "not-a-uuid", questionIndex: 0, choice: 0 }, "quizId must be a quiz id"],
    [{ quizId: QZ, questionIndex: -1, choice: 0 }, "questionIndex must be a whole number"],
    [{ quizId: QZ, questionIndex: 0.5, choice: 0 }, "questionIndex must be a whole number"],
    [{ quizId: QZ, questionIndex: 0, choice: 4 }, "choice must be 0-3, or null when time ran out"],
    [{ quizId: QZ, questionIndex: 0, choice: "A" }, "choice must be 0-3, or null when time ran out"],
    [{ quizId: QZ, questionIndex: 0 }, "choice must be 0-3, or null when time ran out"],
  ])("refuses %j", (body, error) => {
    expect(parseAnswerRequest(body)).toEqual({ ok: false, error });
  });

  it("refuses a body that is not an object", () => {
    expect(parseAnswerRequest([1, 2])).toEqual({ ok: false, error: "Invalid request body" });
  });
});

describe("parseSubmitRequest: the submit route's body", () => {
  it("accepts a quiz and the card it was generated for", () => {
    expect(parseSubmitRequest({ quizId: QZ, milestoneId: CARD }))
      .toEqual({ ok: true, request: { quizId: QZ, milestoneId: CARD } });
  });

  it.each([
    [{ milestoneId: CARD }, "quizId must be a quiz id"],
    [{ quizId: QZ }, "milestoneId must be a milestone id"],
    [{ quizId: QZ, milestoneId: "card'; drop table" }, "milestoneId must be a milestone id"],
    [null, "Invalid request body"],
  ])("refuses %j", (body, error) => {
    expect(parseSubmitRequest(body)).toEqual({ ok: false, error });
  });
});

describe("questionExists", () => {
  it("knows which indexes this quiz has", () => {
    expect(questionExists(quiz, 2)).toBe(true);
    expect(questionExists(quiz, 3)).toBe(false);
  });
});

describe("revealFor: the feedback after a locked answer", () => {
  it("marks a right answer right and shows the explanation and the line from the notes", () => {
    expect(revealFor(quiz[1], 1, 2)).toEqual({
      questionIndex: 1, choice: 2, correct: true, correctIndex: 2,
      explanation: "Because 2.", source: "a verbatim line from note 2",
    });
  });

  it("marks a timed-out question wrong", () => {
    expect(revealFor(quiz[0], 0, null).correct).toBe(false);
  });
});

describe("gradeQuiz: the server decides the pass", () => {
  const answers = (...choices: (number | null)[]) =>
    choices.map((choice, question_index) => ({ question_index, choice }));

  it("passes a quiz with every question right", () => {
    expect(gradeQuiz(quiz, answers(0, 2, 3))).toEqual({ total: 3, correct: 3, answered: 3, passed: true });
  });

  it("fails a quiz with one question wrong — the bar is all of them", () => {
    expect(gradeQuiz(quiz, answers(0, 1, 3))).toMatchObject({ correct: 2, passed: false });
  });

  it("fails a quiz with a question whose timer ran out", () => {
    expect(gradeQuiz(quiz, answers(0, null, 3))).toMatchObject({ correct: 2, answered: 3, passed: false });
  });

  it("counts an unanswered question as wrong, so submitting early cannot pass", () => {
    expect(gradeQuiz(quiz, answers(0, 2))).toEqual({ total: 3, correct: 2, answered: 2, passed: false });
  });

  it("ignores answers to questions the quiz does not have", () => {
    expect(gradeQuiz(quiz, [...answers(0, 2), { question_index: 7, choice: 3 }]))
      .toMatchObject({ answered: 2, passed: false });
  });

  it("keeps the first locked answer if the same question somehow appears twice", () => {
    expect(gradeQuiz(quiz, [...answers(0, 1, 3), { question_index: 1, choice: 2 }]))
      .toMatchObject({ correct: 2, passed: false });
  });

  it("never passes an empty quiz, which would otherwise be 'all correct'", () => {
    expect(gradeQuiz([], []).passed).toBe(false);
  });
});

describe("reviewWrite: what a graded quiz records on the card", () => {
  it("validates the review on a pass", () => {
    expect(reviewWrite({ total: 2, correct: 2, answered: 2, passed: true })).toEqual({ review_validated: true });
  });

  it("writes nothing on a fail, so a practice retake never revokes a reviewed card", () => {
    expect(reviewWrite({ total: 2, correct: 1, answered: 2, passed: false })).toBeNull();
  });
});
