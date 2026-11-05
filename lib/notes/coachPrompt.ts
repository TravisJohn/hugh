import { MAX_IMAGE_FILE_LABEL, type CallImage, type ImageCall } from "@/lib/claude/imageInput";
import type { TextMessage } from "@/lib/claude/textInput";
import type { NoteMessageRole } from "@/types";

// ── The Coach: Hugh reads a test screenshot + the learner's reasoning ─────────
// This module is the *pure* payload builder for the Coach route — no Claude
// client, no I/O — so the message assembly can be unit-tested in isolation.

export const COACH_SYSTEM_PROMPT = [
  "You are Hugh, a sharp, encouraging coach for data & analytics practitioners",
  "(data engineering, data science, ML engineering, SQL, analytics, and the",
  "major clouds — AWS, GCP, Azure).",
  "",
  "The learner is reviewing a practice/exam question they got wrong or want to",
  "check. You are given: (1) the screenshot(s) of the question, and (2) the",
  "learner's own written reasoning — what they think the answer is and WHY.",
  "",
  "If more than one image is supplied, they are consecutive slices of ONE",
  "question — a page too tall to capture in a single screenshot — given top to",
  "bottom. Read them as one continuous page, never as separate questions. An",
  "option list may run across the boundary between two slices.",
  "",
  "Your job is to correct their thinking, not just hand over the answer:",
  "- Read the question in the screenshot carefully, including every option.",
  "- State the correct answer plainly and briefly.",
  "- Explain WHY it is correct, and pinpoint exactly where the learner's",
  "  reasoning went right or wrong — quote the phrase of theirs you're reacting to.",
  "- If they chose a wrong option, explain the specific trap that makes it look",
  "  right, so they recognise the pattern next time.",
  "- If their reasoning was sound, say so and reinforce the mental model.",
  "",
  "Be concise and concrete. Lead with the answer, then the why. Use plain",
  "language and short paragraphs; a compact bulleted list is fine. Write in a",
  "direct tone, without emoji. Do not invent details that aren't visible in the",
  "screenshot — if something is unreadable or missing, say so and ask for it. Stay",
  "within the data & analytics domain; if the screenshot is clearly off-topic,",
  "gently say this coach is for data work.",
].join("\n");

// The preamble names how many slices are coming and in what order, so the model
// stitches a two-part capture back into one question instead of treating the
// second half as a new one.
export function imagePreamble(count: number): string {
  return count > 1
    ? `Here are ${count} slices of a single question, in order from top to bottom. ` +
      "Read them as one continuous page before responding."
    : "Here is the screenshot of the question for this note. Read it carefully before responding.";
}

// Structural type for a message row — matches the persisted NoteMessage subset
// we care about, but kept local so callers can pass any compatible shape.
export interface CoachThreadMessage {
  role: NoteMessageRole;
  content: string;
}

// The Coach button works on a screenshot with no thoughts yet, and again right
// after Hugh has answered. Claude needs a conversation to end on the learner's
// turn: the API refuses one ending on its own reply and the plan path cannot
// write one. So each case gets a closing turn saying what the press means. These
// are sent, never stored.
export const COACH_FIRST_LOOK_TURN =
  "I haven't written my reasoning yet. Please answer the question in the screenshot and explain why.";
export const COACH_ANOTHER_LOOK_TURN =
  "Please take another look at the question and add anything your last reply missed.";

/** The thread as Claude takes it: real roles, oldest first, always ending on the learner. */
export function coachTurns(thread: readonly CoachThreadMessage[]): TextMessage[] {
  const turns = thread
    .filter(message => message.content.trim())
    .map(({ role, content }) => ({ role, content }));
  const last = turns[turns.length - 1];
  if (!last) return [{ role: "user", content: COACH_FIRST_LOOK_TURN }];
  if (last.role === "assistant") return [...turns, { role: "user", content: COACH_ANOTHER_LOOK_TURN }];
  return turns;
}

/**
 * Assemble a Coach turn. The images go in once, ahead of the thread, so the
 * model has them in view for the whole conversation; the thread keeps its real
 * user/assistant roles so follow-up turns read as a genuine conversation.
 */
export function buildCoachCall(
  settings: { model: string; maxTokens: number },
  thread: readonly CoachThreadMessage[],
  images: CallImage[],
): ImageCall {
  return {
    model: settings.model,
    max_tokens: settings.maxTokens,
    system: COACH_SYSTEM_PROMPT,
    imageCaption: imagePreamble(images.length),
    images,
    messages: coachTurns(thread),
  };
}

/** One slice of a question as the route read it from Storage. */
export type CoachSlice = CallImage | "unreadable" | "not-an-image" | "too-large";

export interface CoachImageProblem {
  status: 413 | 415 | 502;
  error: string;
  /** A file that can't be sent is refused; only a failed read is the system failing. */
  outcome: "refused" | "failed";
  stage: string;
}

/**
 * What stops this question reaching the Coach, or null. Any one slice stops it:
 * half a question would produce a confident answer to something the learner
 * never asked. Each reason has its own sentence because each has its own way
 * out, and only an unreadable file is worth retrying.
 */
export function coachImageProblem(slices: readonly CoachSlice[]): CoachImageProblem | null {
  if (slices.includes("too-large")) {
    return {
      status: 413,
      error: `That screenshot is over ${MAX_IMAGE_FILE_LABEL}, too large for the Coach to read. Upload a smaller copy.`,
      outcome: "refused",
      stage: "image-too-large",
    };
  }
  if (slices.includes("not-an-image")) {
    return {
      status: 415,
      error: "The Coach can't read that file as a picture. Upload it again as a PNG, JPEG, WebP or GIF.",
      outcome: "refused",
      stage: "not-an-image",
    };
  }
  if (slices.includes("unreadable")) {
    return { status: 502, error: "Couldn't read that screenshot. Try again.", outcome: "failed", stage: "read-screenshot" };
  }
  return null;
}
