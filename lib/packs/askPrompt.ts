// ── Ask Hugh on a course card ───────────────────────────────────────────────
// The tutor's system prompt for a card built from a reference pack
// (PRD-narrow-learn.md, row 3). It is today's tutor prompt, unchanged, so the
// reply's JSON contract and the code-mode rules hold, followed by the course
// rules and the card's syllabus.
//
// Built on the server from the card's concept ids. The browser no longer
// chooses the tutor's subject for a course card.
//
// Ordered for the prompt cache: everything here is fixed for a card, so the
// whole system prompt is one stable prefix across a conversation.
//
// Pure: no I/O, no `server-only`.

import { focusedLearningSystemPrompt } from "@/lib/claude/prompts";
import { renderCardSyllabus, type CardGround } from "./grounding";

/** The exact words a reply outside the syllabus opens with, so the learner can always tell. */
export const OUTSIDE_SYLLABUS_LABEL = "Outside this course's source-checked syllabus:";

export function courseRules(): string {
  return `Course rules (these override the rules above wherever they differ):
A. This card belongs to a course with a source-checked syllabus, given below inside <course_syllabus>. Its key points and corrections are the authority for this card. Answer from them, in your own words, and never contradict them.
B. If the learner states one of the listed wrong beliefs, say plainly that it is a common misconception and give its correction.
C. If the question is covered by ANOTHER card in this course (see "Other cards in this course"), give a short answer and name that card: That's covered in the card "<card title>".
D. If the question is outside this course's syllabus, start "reply" with exactly "${OUTSIDE_SYLLABUS_LABEL}". Then give at most one orienting sentence, followed by the ready-to-paste chatbot prompt from rule 2. Never present such an answer as source-checked. Things the course does not cover are listed in the syllabus.
E. Never write links or cite URLs: the page shows this card's sources itself.`;
}

/** The full system prompt for Ask on a course card. */
export function courseAskSystemPrompt(g: CardGround, cardTitle: string): string {
  return [
    focusedLearningSystemPrompt(`${g.subject}: ${cardTitle}`),
    courseRules(),
    renderCardSyllabus(g),
  ].join("\n\n");
}
