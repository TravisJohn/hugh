/** Shared browser/server limits. Bytes, not characters, bound multilingual text too. */
export const TEXT_LIMITS = {
  requestBytes: 192 * 1024,
  messageBytes: 16 * 1024,
  transcriptBytes: 64 * 1024,
  promptBytes: 128 * 1024,
  topicBytes: 1600,
  contextBytes: 8 * 1024,
  answerBytes: 4 * 1024,
  answers: 5,
} as const;

export class TextInputError extends Error {
  constructor(message: string, public readonly status: 400 | 413 = 400) {
    super(message);
    this.name = "TextInputError";
  }
}

export const textBytes = (text: string): number => new TextEncoder().encode(text).byteLength;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TextInputError("Expected a JSON object.");
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TextInputError("Unexpected request field.");
}

function string(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim())) throw new TextInputError(`${name} must be text${empty ? "" : " and cannot be empty"}.`);
  if (textBytes(value) > max) throw new TextInputError(`${name} is too long. Shorten it and try again.`, 413);
  return value;
}

export interface TextMessage { role: "user" | "assistant"; content: string }
/** Chat alone uses a recent window; summaries/assessments must keep all evidence. */
export function recentTextMessages(messages: TextMessage[], count: number): TextMessage[] {
  const recent = messages.slice(-count);
  let bytes = recent.reduce((n, m) => n + textBytes(m.content), 0);
  while (recent.length > 1 && (bytes > TEXT_LIMITS.transcriptBytes || recent[0].role === "assistant")) {
    bytes -= textBytes(recent.shift()!.content);
  }
  return recent;
}
export interface SessionMessage { role: "hugh" | "learner"; text: string }
interface AnswersBody { topic: string; answers: Array<{ question: string; answer: string }> }
export interface TextBodies {
  learn: { topic: string; messages: TextMessage[]; focusMode?: boolean; codeModeRequested?: boolean };
  code: { messages: TextMessage[]; context: string };
  cloud: { provider: string; serviceId: string; messages: TextMessage[] };
  summary: { topic: string; messages: TextMessage[] };
  refine: AnswersBody;
  goals: AnswersBody & { end_date: string };
  session: { milestoneId: string; scenario: "interview" | "client" | "huddle" | "teaching"; phase: "open" | "respond" | "evaluate"; messages: SessionMessage[] };
}
export type TextRoute = keyof TextBodies;

function messages(value: unknown, max: number, session = false, allowEmpty = false): TextMessage[] | SessionMessage[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new TextInputError("messages must be a non-empty array.");
  if (value.length > max) throw new TextInputError(`This conversation is too long (maximum ${max} messages). Start a shorter session.`, 413);
  let total = 0;
  const result = value.map(item => {
    const m = object(item);
    fields(m, session ? ["role", "text"] : ["role", "content"]);
    const roles = session ? ["hugh", "learner"] : ["user", "assistant"];
    if (typeof m.role !== "string" || !roles.includes(m.role)) throw new TextInputError("Invalid message role.");
    const text = string(session ? m.text : m.content, "Message", TEXT_LIMITS.messageBytes);
    total += textBytes(text);
    return session ? { role: m.role, text } : { role: m.role, content: text };
  });
  if (total > TEXT_LIMITS.transcriptBytes) throw new TextInputError("This conversation is too long. Shorten it or start a new session.", 413);
  return result as TextMessage[] | SessionMessage[];
}

function answers(body: Record<string, unknown>): AnswersBody {
  const topic = string(body.topic, "Topic", TEXT_LIMITS.topicBytes);
  const source = body.answers === undefined ? [] : body.answers;
  if (!Array.isArray(source)) throw new TextInputError("answers must be an array.");
  if (source.length > TEXT_LIMITS.answers) throw new TextInputError("At most five refinement answers are allowed.", 413);
  return { topic, answers: source.map(value => {
    const a = object(value);
    fields(a, ["question", "answer"]);
    return { question: string(a.question, "Question", 2048), answer: string(a.answer, "Answer", TEXT_LIMITS.answerBytes) };
  }) };
}

function parse(kind: TextRoute, value: unknown): TextBodies[TextRoute] {
  const b = object(value);
  switch (kind) {
    case "learn":
    case "summary": {
      fields(b, kind === "learn" ? ["topic", "messages", "focusMode", "codeModeRequested"] : ["topic", "messages"]);
      for (const key of ["focusMode", "codeModeRequested"]) {
        if (b[key] !== undefined && typeof b[key] !== "boolean") throw new TextInputError(`${key} must be a boolean.`);
      }
      return { topic: string(b.topic, "Topic", TEXT_LIMITS.topicBytes), messages: messages(b.messages, kind === "learn" ? 20 : 100) as TextMessage[], focusMode: b.focusMode as boolean | undefined, codeModeRequested: b.codeModeRequested as boolean | undefined };
    }
    case "code":
      fields(b, ["messages", "context"]);
      return { messages: messages(b.messages, 12) as TextMessage[], context: string(b.context === undefined ? "" : b.context, "Code context", TEXT_LIMITS.contextBytes, true) };
    case "cloud":
      fields(b, ["provider", "serviceId", "messages"]);
      return { provider: string(b.provider, "Provider", 40), serviceId: string(b.serviceId, "Service", 100), messages: messages(b.messages, 12) as TextMessage[] };
    case "refine":
      fields(b, ["topic", "answers"]);
      return answers(b);
    case "goals": {
      fields(b, ["topic", "answers", "end_date"]);
      const end_date = string(b.end_date, "End date", 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(end_date) || !Number.isFinite(Date.parse(end_date)) || new Date(end_date).toISOString().slice(0, 10) !== end_date) throw new TextInputError("End date must be a valid YYYY-MM-DD date.");
      return { ...answers(b), end_date };
    }
    case "session": {
      fields(b, ["milestoneId", "scenario", "phase", "messages"]);
      const milestoneId = string(b.milestoneId, "Milestone", 36);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(milestoneId)) throw new TextInputError("Invalid milestone ID.");
      if (typeof b.scenario !== "string" || !["interview", "client", "huddle", "teaching"].includes(b.scenario)) throw new TextInputError("Invalid scenario.");
      if (typeof b.phase !== "string" || !["open", "respond", "evaluate"].includes(b.phase)) throw new TextInputError("Invalid phase.");
      const transcript = messages(b.messages, 6, true, b.phase === "open") as SessionMessage[];
      if (b.phase === "open" && transcript.length !== 0) throw new TextInputError("An opening request must have an empty conversation.");
      return { milestoneId, scenario: b.scenario as TextBodies["session"]["scenario"], phase: b.phase as TextBodies["session"]["phase"], messages: transcript };
    }
  }
}

export function parseTextBody<K extends TextRoute>(kind: K, value: unknown): TextBodies[K] {
  return parse(kind, value) as TextBodies[K];
}

/** Only ordinary text is supported: no tools, images, documents, thinking or streams. */
export interface TextCall {
  model: string;
  max_tokens: number;
  system?: string;
  messages: TextMessage[];
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
}
export type TextCallGuard = (call: TextCall, attempts?: number) => Promise<void>;

/** Conservative admission allowance, NOT a tokenizer: one token per UTF-8 byte
 * plus generous framing headroom. No chars/4 assumption or cache-read discount.
 * Bound the assembled prompt too, including trusted templates/database context.
 */
export function textReservation(call: TextCall, attempts = 1): number {
  const bytes = textBytes(call.system ?? "") + call.messages.reduce((n, m) => n + textBytes(m.content), 0);
  if (bytes > TEXT_LIMITS.promptBytes) throw new TextInputError("The conversation and its supporting context are too long. Use a shorter session or reduce the notes.", 413);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 2 || !Number.isSafeInteger(call.max_tokens) || call.max_tokens < 1 || call.max_tokens > 4096) throw new Error("Invalid text reservation configuration");
  return attempts * (bytes + 1024 + call.messages.length * 64 + call.max_tokens);
}
