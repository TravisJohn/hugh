import { readTextRequest } from "@/lib/claude/textRequest";
import { createTextMessage, textBudgetResponse } from "@/lib/claude/textBudget";
import { type NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { logUsage } from "@/lib/usage";
import { refinementQuestionPrompt, parseClaudeJson } from "@/lib/claude/prompts";
import { checkTopic, TOPIC_REJECTION_MESSAGE } from "@/lib/learn/topicInput";
import { logSafeError } from "@/lib/observability/log";
import { recordOperation } from "@/lib/observability/record";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 5-whys refinement question (short conversational gen) — Haiku is sufficient.
// See CLAUDE.md "Model Selection". Kept in one place so the API call and the
// usage log can never disagree about what was billed.
const MODEL = "claude-haiku-4-5";

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const input = await readTextRequest(request, "refine");
  if (input.response) return input.response;
  const body = input.body;

  const { answers = [] } = body;

  // Same boundary as every other topic entry point.
  const checked = checkTopic(body.topic ?? "");
  if (!checked.ok) {
    // Turning away a bad topic is the boundary working, so 'refused'. The
    // rejection class is safe to record; the topic text itself never is.
    void recordOperation({
      userId, operation: "track.refine", outcome: "refused",
      detail: { rejection: checked.rejection },
    });
    return NextResponse.json(
      { error: TOPIC_REJECTION_MESSAGE[checked.rejection] },
      { status: 400 },
    );
  }

  const prompt = refinementQuestionPrompt(checked.topic, answers);

  const startedAt = Date.now();

  // Retry once: the Claude call or JSON parse can fail transiently. A single
  // retry keeps the refinement flow moving without hanging the client.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msg = await createTextMessage(anthropic, userId, "dashboard/refine", {
        model:      MODEL,
        max_tokens: 200,
        messages:   [{ role: "user", content: prompt }],
      });
      // Logged per attempt: a failed parse still burned tokens.
      void logUsage({
        userId,
        model:     MODEL,
        feature:   "dashboard/refine",
        tokensIn:  msg.usage.input_tokens,
        tokensOut: msg.usage.output_tokens,
      });
      const text   = msg.content[0]?.type === "text" ? msg.content[0].text : "";
      const result = parseClaudeJson<{ question: string; done: boolean }>(text);
      // One row per REQUEST, not per attempt: a retry that succeeds is one
      // successful refinement. `attempt` carries how many tries it took, which
      // is where a degrading model would show up first.
      void recordOperation({
        userId, operation: "track.refine", outcome: "ok",
        durationMs: Date.now() - startedAt, detail: { attempt: attempt + 1 },
      });
      return NextResponse.json(result);
    } catch (err) {
      const refusal = textBudgetResponse(err);
      if (refusal) return refusal;
      lastErr = err;
    }
  }

  // The richest learner text in the product travels through this route — five
  // free-text answers about their job, motivation and circumstances. An SDK
  // error can quote the request that carried them, so the topic and every
  // answer are named as secrets here.
  logSafeError("dashboard/refine", lastErr, [checked.topic, ...answers.map(a => a.answer)]);
  // Both attempts billed, so one 'failed' row here can represent two charges.
  void recordOperation({
    userId, operation: "track.refine", outcome: "failed",
    durationMs: Date.now() - startedAt, error: lastErr,
    redact: [checked.topic, ...answers.map(a => a.answer)],
    detail: { attempts: 2 },
  });
  return NextResponse.json({ error: "Failed to generate question" }, { status: 502 });
}
