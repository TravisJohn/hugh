import { readTextRequest } from "@/lib/claude/textRequest";
import { createTextMessage, textBudgetResponse } from "@/lib/claude/textBudget";
import { type NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { focusedLearningSystemPrompt } from "@/lib/claude/prompts";
import { parseChatResponse } from "@/lib/askcode/parse";
import { logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { logSafeError } from "@/lib/observability/log";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
//
// TRIAL: learn/chat is the highest-volume route, so we're testing Haiku
// (5x cheaper input, 3x cheaper output) against Sonnet for tutoring quality.
// Revert this constant to "claude-sonnet-4-6" if the answers get weaker.
const MODEL = "claude-haiku-4-5";

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const input = await readTextRequest(request, "learn");
  if (input.response) return input.response;
  const body = input.body;

  const { topic, messages, focusMode, codeModeRequested } = body;

  if (!topic?.trim() || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "topic and messages are required" }, { status: 400 });
  }

  // Validated, bounded transcript; copy before adding the server reminder.
  const capped = [...messages];

  // Code-mode request: the keyword only *gates* the request — Hugh's own reply
  // decides whether the topic is code-worthy. We signal the explicit ask by
  // appending a reminder to the FINAL user turn only, never the system prompt, so
  // the cached prompt prefix (system + earlier turns) stays intact across turns.
  if (codeModeRequested && capped.length > 0) {
    const last = capped[capped.length - 1];
    if (last.role === "user") {
      capped[capped.length - 1] = {
        role:    "user",
        content: `${last.content}\n\n[The learner has explicitly requested code mode. If this topic has real code worth practising, return a codeExample plus a mirror-typing action point; if it does not, set codeExample to null and explain that code isn't needed here.]`,
      };
    }
  }

  try {
    const res = await createTextMessage(anthropic, userId, "learn/chat", {
      model:      MODEL,
      max_tokens: 1024,
      system:     focusedLearningSystemPrompt(topic.trim()),
      messages:   capped,
      // Prompt caching: auto-place a breakpoint on the last message, so the
      // system prompt + prior conversation prefix is reused across turns of the
      // same chat. Cache reads cost ~0.1x; this is the bulk of learn/chat spend.
      // (Effective once the prefix exceeds Haiku's ~4096-token cache minimum —
      // a bit later than Sonnet's 2048; shorter prefixes silently skip.)
      //
      // During a Pomodoro focus block we switch to the 1-hour TTL: deliberate,
      // spaced study leaves gaps >5 min between questions, which would expire the
      // default cache and force a re-write each turn. The 1h write costs 2x (vs
      // 1.25x) but is recovered the moment one such re-write is avoided.
      cache_control: focusMode ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
    });

    const raw = res.content[0].type === "text" ? res.content[0].text : "{}";

    // Tolerant parse: salvages the reply (and a clean code example) even when the
    // model emits unescaped quotes/newlines, so raw JSON never leaks to the chat.
    const { reply, isOffTopic, codeExample, covered } = parseChatResponse(raw);

    // Should be unreachable now (the parser echoes prose), but if a reply ever
    // comes back empty, log the raw output + stop reason so we can diagnose
    // instead of silently showing the generic fallback.
    if (!reply.trim()) {
      // Was logging 500 characters of raw model output — a reply about
      // whatever the learner is studying, written to the Vercel log drain. The
      // diagnosis this line exists for (was it truncated? refused? empty?) is
      // carried by stop_reason and the length; the text itself never was.
      console.warn(`[learn/chat] empty reply; stop_reason: ${res.stop_reason}; raw_length: ${raw.length}`);
    }

    // Count fresh input + cache writes against usage; cache reads (~0.1x cost)
    // are intentionally excluded so a warm cache eases the learner's quota.
    const tokensIn = res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0);
    void logUsage({ userId, model: MODEL, feature: "learn/chat", tokensIn, tokensOut: res.usage.output_tokens });
    // Voided, not awaited: this is the highest-volume route in the product and
    // the learner is waiting on the response. A lost row here costs one data
    // point; an added round trip costs every learner on every message.
    void recordOperation({
      userId, operation: "ask.chat", outcome: "ok",
      durationMs: Date.now() - startedAt, detail: { offTopic: isOffTopic },
    });
    return NextResponse.json({
      reply: reply || "I couldn't generate a response. Please try again.",
      isOffTopic,
      codeExample,
      covered,
    });
  } catch (err) {
    const refusal = textBudgetResponse(err);
    if (refusal) return refusal;
    logSafeError("learn/chat", err, [topic]);
    void recordOperation({
      userId, operation: "ask.chat", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err,
    });
    return NextResponse.json({ error: "Failed to generate response" }, { status: 502 });
  }
}
