import { readTextRequest } from "@/lib/claude/textRequest";
import { createTextMessage, textBudgetResponse } from "@/lib/claude/textBudget";
import { type NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";

// Lightweight coding helper for the Code practice page. Haiku — the job is a
// short, focused Q&A about Python/code, not heavy reasoning (see Model Selection
// in CLAUDE.md). Server-side only; the browser never sees the API key.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-haiku-4-5";

const SYSTEM = `You are Hugh, a friendly, concise coding helper beside a Python fluency drill.
- Answer in one or two sentences. Add a tiny snippet only when it genuinely helps.
- Give the SINGLE most idiomatic answer for THIS code's world — don't dump a list of alternatives unless the learner explicitly asks for options.
- Never invent a different setup than the one described: if the data is a plain list of dicts, don't reach for pandas / DataFrames / .iloc. Match what's actually in front of them.
- The learner is building muscle memory, so nudge toward the idea first; if they explicitly ask for the full answer, give it plainly.
- Stay on programming / data topics. If asked something off-topic, gently steer back.
- No preambles, no lecturing, no filler praise.`;

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Please sign in to use the helper." }, { status: 401 });

  const input = await readTextRequest(request, "code");
  if (input.response) return input.response;
  const body = input.body;
  const messages = body.messages;
  if (messages.length === 0) return NextResponse.json({ error: "messages required" }, { status: 400 });

  // The client sends the current drill card (task + reference + dataset shape) so
  // Hugh answers about the exact code in front of the learner, not a guess.
  const context = body.context;
  const system = context ? `${SYSTEM}\n\nWhat the learner is working on right now:\n${context}` : SYSTEM;

  const startedAt = Date.now();

  try {
    const res = await createTextMessage(anthropic, userId, "code/chat", {
      model: MODEL,
      max_tokens: 500,
      system,
      messages,
    });
    const reply = res.content[0]?.type === "text" ? res.content[0].text : "";
    void logUsage({ userId, model: MODEL, feature: "code/chat", tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens });
    void recordOperation({
      userId, operation: "code.chat", outcome: "ok",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ reply: reply || "Sorry — please try again." });
  } catch (err) {
    const refusal = textBudgetResponse(err);
    if (refusal) {
      void recordOperation({ userId: userId, operation: "code.chat", outcome: "refused", detail: { reason: "text-admission" } });
      return refusal;
    }
    console.error("[code/chat] Claude error:", err);
    void recordOperation({
      userId, operation: "code.chat", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err,
    });
    return NextResponse.json({ error: "Failed to generate a response." }, { status: 502 });
  }
}
