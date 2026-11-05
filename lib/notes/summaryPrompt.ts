import type { TextCall } from "@/lib/claude/textInput";
import type { NoteMessageRole } from "@/types";

// ── The running summary: condense one screenshot's review into revision notes ──
// Pure payload builder for the summarize route (no Claude client, no I/O) so the
// message assembly can be unit-tested in isolation — same pattern as coachPrompt.
// The thread is text-only (the learner's thoughts + Hugh's corrections), so this
// needs no vision.

export const SUMMARY_SYSTEM_PROMPT = [
  "You are Hugh, condensing a learner's review of ONE practice question into tight",
  "revision notes they can re-read later.",
  "",
  "You are given the conversation for a single screenshot: the learner's own written",
  "thoughts (their reasoning / chosen answer) and Hugh's coaching corrections.",
  "",
  "Summarise only what the conversation supports — never invent facts. Cover, where",
  "present:",
  "- The topic / what the question tests.",
  "- The correct answer and the one-line reason it's right.",
  "- The learner's mistake or misconception, and the trap that caused it.",
  "- The takeaway to remember next time.",
  "",
  "Be concise: a few short bullet points or 2-3 short sentences. Plain language. No",
  "preamble ('Here is a summary…') — output the notes directly.",
].join("\n");

// Structural type for a message row — matches the persisted NoteMessage subset we
// care about, kept local so callers can pass any compatible shape.
export interface SummaryThreadMessage {
  role: NoteMessageRole;
  content: string;
}

/**
 * Assemble a summary turn: the system prompt plus a single user message
 * carrying the thread rendered as a labelled transcript (Learner / Hugh). Keeping
 * it one flattened turn (rather than replaying roles) makes the "summarise all of
 * this" instruction unambiguous.
 */
export function buildSummaryPrompt(thread: SummaryThreadMessage[]): Pick<TextCall, "system" | "messages"> {
  const transcript = thread
    .map((m) => `${m.role === "user" ? "Learner" : "Hugh"}: ${m.content}`)
    .join("\n\n");

  return {
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Summarise this review into revision notes:\n\n${transcript}` }],
  };
}
