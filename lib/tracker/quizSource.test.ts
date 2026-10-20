import { describe, it, expect } from "vitest";
import {
  buildEntriesText,
  entryMaterial,
  sourceCharCount,
  questionTarget,
  normalizeForMatch,
  isGrounded,
  isWellFormed,
  keepGroundedQuestions,
  keepSyllabusQuestions,
  MIN_QUESTIONS,
  MAX_QUESTIONS,
  MAX_ENTRY_CHARS,
  type GeneratedQuestion,
} from "./quizSource";

const validQuestion = (over: Partial<GeneratedQuestion> = {}): GeneratedQuestion => ({
  question:     "Why does transposing help here?",
  options:      ["A", "B", "C", "D"],
  correctIndex: 1,
  explanation:  "Because it squares the matrix.",
  source:       "Transpose converts rectangular data into a square matrix",
  ...over,
});

describe("entryMaterial — quizzes read what was established, not what was discussed", () => {
  const narrative = "The student explored dot products and worked through the normal equation.";

  it("uses the recorded points when the entry has them", () => {
    const material = entryMaterial({
      title:   "Normal Equation",
      body:    narrative,
      covered: [
        { point: "Dot product alignment", detail: "Two vectors must match in length." },
        { point: "Normal equation",       detail: "Transposing yields a square matrix." },
      ],
    });

    expect(material).toContain("Two vectors must match in length.");
    expect(material).toContain("Transposing yields a square matrix.");
  });

  it("excludes the narrative body entirely when points exist", () => {
    // Otherwise a question could be 'grounded' in a sentence that only records
    // that a subject came up — which is the bug this whole module exists for.
    const material = entryMaterial({
      title:   null,
      body:    narrative,
      covered: [{ point: "Covariance", detail: "It measures joint variation." }],
    });

    expect(material).not.toContain("The student explored");
  });

  it("falls back to the body for entries saved before covered existed", () => {
    expect(entryMaterial({ title: null, body: narrative, covered: null })).toBe(narrative);
    expect(entryMaterial({ title: null, body: narrative })).toBe(narrative);
  });

  it("treats an empty points list as absent", () => {
    expect(entryMaterial({ title: null, body: narrative, covered: [] })).toBe(narrative);
  });

  it("returns an empty string when there is nothing at all", () => {
    expect(entryMaterial({ title: null, body: null })).toBe("");
  });
});

describe("questionTarget — the quiz may not ask more than the notes support", () => {
  it("gives a thin card the floor, not five questions", () => {
    // The card that prompted this fix: one 961-character narrative entry.
    expect(questionTarget(961)).toBe(2);
  });

  it("never drops below the floor, even for a near-empty note", () => {
    expect(questionTarget(0)).toBe(MIN_QUESTIONS);
    expect(questionTarget(80)).toBe(MIN_QUESTIONS);
  });

  it("never exceeds the ceiling, however long the notes run", () => {
    expect(questionTarget(50_000)).toBe(MAX_QUESTIONS);
  });

  it("scales in between so a fuller card earns more questions", () => {
    expect(questionTarget(1_400)).toBe(3);
    expect(questionTarget(1_800)).toBe(4);
  });
});

describe("sourceCharCount — measures real material, not scaffolding", () => {
  it("counts titles and bodies across entries", () => {
    const chars = sourceCharCount([
      { title: "abc", body: "12345" },
      { title: null,  body: "678" },
    ]);
    expect(chars).toBe(3 + 5 + 3);
  });

  it("counts a long body only up to the cap the model actually receives", () => {
    const chars = sourceCharCount([{ title: null, body: "x".repeat(MAX_ENTRY_CHARS + 500) }]);
    expect(chars).toBe(MAX_ENTRY_CHARS);
  });
});

describe("normalizeForMatch — quotes must survive a model's re-typing", () => {
  it("flattens case, punctuation and line breaks", () => {
    expect(normalizeForMatch("The Normal\nEquation, solved!")).toBe("the normal equation solved");
  });
});

describe("isGrounded — a question must be traceable to the notes", () => {
  const notes = normalizeForMatch(
    "Transpose converts rectangular data into a square matrix, enabling the normal equation."
  );

  it("accepts a verbatim quote", () => {
    expect(isGrounded("Transpose converts rectangular data into a square matrix", notes)).toBe(true);
  });

  it("accepts a quote the model re-punctuated or re-wrapped", () => {
    expect(isGrounded("transpose  converts rectangular data\ninto a square matrix!", notes)).toBe(true);
  });

  it("rejects a claim the notes never made — the actual reported bug", () => {
    expect(isGrounded("Gradient descent converges in O(n log n) time", notes)).toBe(false);
  });

  it("rejects a quote too short to prove anything", () => {
    expect(isGrounded("the", notes)).toBe(false);
    expect(isGrounded("", notes)).toBe(false);
  });
});

describe("isWellFormed — the model's JSON is never trusted", () => {
  it("accepts a complete question", () => {
    expect(isWellFormed(validQuestion())).toBe(true);
  });

  it("rejects the wrong number of options", () => {
    expect(isWellFormed(validQuestion({ options: ["A", "B", "C"] }))).toBe(false);
  });

  it("rejects a correctIndex outside the options", () => {
    expect(isWellFormed(validQuestion({ correctIndex: 4 }))).toBe(false);
    expect(isWellFormed(validQuestion({ correctIndex: -1 }))).toBe(false);
  });

  it("rejects a missing source quote", () => {
    expect(isWellFormed({ ...validQuestion(), source: undefined })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isWellFormed(null)).toBe(false);
    expect(isWellFormed("question")).toBe(false);
  });
});

describe("keepGroundedQuestions — ungrounded questions never reach the learner", () => {
  const entriesText = buildEntriesText([
    {
      title: "Normal Equation Math Behind Linear Regression",
      body:  "Transpose converts rectangular data into a square matrix, enabling the " +
             "normal equation to solve regression weights directly. For massive " +
             "datasets, gradient descent beats direct inversion.",
    },
  ]);

  it("keeps a question quoting the notes and drops one that invents material", () => {
    const { kept, ungrounded } = keepGroundedQuestions(
      [
        validQuestion(),
        validQuestion({ source: "Ridge regression penalises large coefficients" }),
      ],
      entriesText,
      5
    );

    expect(kept).toHaveLength(1);
    expect(ungrounded).toBe(1);
    expect(kept[0].source).toContain("Transpose converts");
  });

  it("counts malformed questions separately from ungrounded ones", () => {
    const { kept, malformed, ungrounded } = keepGroundedQuestions(
      [validQuestion({ options: ["only", "three", "here"] }), validQuestion()],
      entriesText,
      5
    );

    expect(malformed).toBe(1);
    expect(ungrounded).toBe(0);
    expect(kept).toHaveLength(1);
  });

  it("trims to the limit so the model cannot widen a thin quiz", () => {
    const { kept } = keepGroundedQuestions(
      [validQuestion(), validQuestion(), validQuestion(), validQuestion()],
      entriesText,
      2
    );
    expect(kept).toHaveLength(2);
  });

  it("returns nothing for a non-array response rather than throwing", () => {
    expect(keepGroundedQuestions({ questions: [] }, entriesText, 5).kept).toEqual([]);
  });
});

describe("buildEntriesText", () => {
  it("labels entries and separates them so quotes stay attributable", () => {
    const text = buildEntriesText([
      { title: "First", body: "alpha" },
      { title: null,    body: "beta"  },
    ]);
    expect(text).toContain("Note 1 — First:");
    expect(text).toContain("Note 2:");
    expect(text).toContain("---");
  });

  it("truncates an over-long body to the cap", () => {
    const text = buildEntriesText([{ title: null, body: "y".repeat(MAX_ENTRY_CHARS + 100) }]);
    expect(text).not.toContain("y".repeat(MAX_ENTRY_CHARS + 1));
  });
});

describe("keepSyllabusQuestions (a course card's quiz, PRD row 4)", () => {
  const base = { question: "Q?", options: ["a", "b", "c", "d"], correctIndex: 0, explanation: "E.", source: "notes" };

  it("keeps a question that names one of the card's key points", () => {
    const q = { ...base, keyPoint: "collinearity:2" };
    expect(keepSyllabusQuestions([q], ["collinearity:1", "collinearity:2"])).toEqual({ kept: [q], offSyllabus: 0 });
  });

  it("drops a question that tests nothing on the syllabus, or a key point the card does not have", () => {
    const untagged = { ...base };
    const elsewhere = { ...base, keyPoint: "least_squares:1" };
    expect(keepSyllabusQuestions([untagged, elsewhere], ["collinearity:1"])).toEqual({ kept: [], offSyllabus: 2 });
  });

  it("accepts the tag in the well-formed check, and refuses a tag that is not text", () => {
    expect(isWellFormed({ ...base, keyPoint: "collinearity:1" })).toBe(true);
    expect(isWellFormed({ ...base, keyPoint: 3 })).toBe(false);
  });
});
