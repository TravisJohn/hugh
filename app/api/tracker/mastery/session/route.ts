import { readTextRequest } from "@/lib/claude/textRequest";
import { createTextMessage, textBudgetResponse } from "@/lib/claude/textBudget";
import { type NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { stripEmphasis } from "@/lib/claude/prompts";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_EXCHANGES = 3;

const SCENARIO_PERSONAS: Record<string, string> = {
  interview: "a sharp senior technical interviewer assessing depth and clarity",
  client:    "a smart but non-technical business client who needs to understand this topic",
  huddle:    "a capable new team member who missed the context and needs a clear rundown",
  teaching:  "an eager but inexperienced junior developer who needs clear guidance",
};

interface Message {
  role: "hugh" | "learner";
  text: string;
}

function buildConversationText(messages: Message[]): string {
  return messages
    .map(m => (m.role === "hugh" ? `Hugh: ${m.text}` : `Learner: ${m.text}`))
    .join("\n");
}


export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const input = await readTextRequest(request, "session");
  if (input.response) return input.response;
  const body = input.body;
  const { milestoneId, scenario, phase, messages } = body;

  if (!milestoneId || !scenario || !phase) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (!SCENARIO_PERSONAS[scenario]) {
    return NextResponse.json({ error: "Invalid scenario" }, { status: 400 });
  }

  const supabase = await createClient();

  // Verify ownership
  const { data: milestone } = await supabase
    .from("milestones")
    .select("id, title, tracks!track_id!inner(user_id)")
    .eq("id", milestoneId)
    .single();

  if (!milestone) {
    return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
  }

  // Fetch diary entries
  const { data: entries } = await supabase
    .from("milestone_entries")
    .select("title, body")
    .eq("milestone_id", milestoneId)
    .order("created_at", { ascending: true })
    .limit(65);

  if (!entries || entries.length === 0) {
    return NextResponse.json({ error: "No diary entries found" }, { status: 422 });
  }

  if (entries.length > 64) return NextResponse.json({ error: "Too many notes for one assessment. Use a smaller milestone." }, { status: 413 });

  const entriesText = entries
    .map((e, i) => `[Entry ${i + 1}]${e.title ? ` ${e.title}` : ""}\n${(e.body ?? "")}`)
    .join("\n\n");

  const persona    = SCENARIO_PERSONAS[scenario];
  const topicTitle = (milestone as { title: string }).title;

  let prompt = "";

  if (phase === "open") {
    prompt = `You are acting as ${persona}.
The topic being assessed is: "${topicTitle}"

Here is context from the learner's own notes about this topic:
---
${entriesText}
---

Generate ONE natural opening line that:
1. Sets the conversational context implicitly — do not describe or announce the scenario
2. Invites the learner to explain or demonstrate their understanding of "${topicTitle}"
3. Is 1-2 sentences, conversational, authentic to your role as ${persona}
4. Does NOT start with "As a..." or similar role announcements

Return ONLY the spoken line. No quotes, no stage directions, no labels.
This line is read aloud — use plain text only, no markdown, asterisks, or emphasis markers.`;

  } else if (phase === "respond") {
    const conversationText = buildConversationText(messages);
    const learnerCount     = messages.filter(m => m.role === "learner").length;

    if (learnerCount >= MAX_EXCHANGES) {
      return NextResponse.json({ error: "Max exchanges reached — use evaluate phase" }, { status: 400 });
    }

    prompt = `You are acting as ${persona} in a conversation about "${topicTitle}".

Context from the learner's own notes:
---
${entriesText}
---

Conversation so far:
${conversationText}

Generate ONE natural follow-up line that:
1. Reacts authentically to what the learner just said
2. Either probes a specific point they mentioned OR asks them to expand on something they glossed over
3. Is 1-2 sentences, stays in character as ${persona}
4. Keeps the conversation moving forward naturally

Return ONLY the spoken line. No quotes, no stage directions.
This line is read aloud — use plain text only, no markdown, asterisks, or emphasis markers.`;

  } else if (phase === "evaluate") {
    const conversationText = buildConversationText(messages);

    prompt = `You are evaluating a learner's verbal mastery of: "${topicTitle}"

Context from the learner's own notes:
---
${entriesText}
---

Full conversation (${scenario} scenario, Hugh playing ${persona}):
${conversationText}

Score the learner from 1 to 10 across these dimensions:
- Accuracy: are their explanations factually correct relative to their own notes?
- Clarity: are they explained well and easy to follow?
- Confidence: do they sound fluent and self-assured?
- Completeness: did they cover the key aspects of the topic?

A score of 7 or higher means they have demonstrated sufficient mastery.

Return ONLY valid JSON with no markdown fences:
{
  "score": <integer 1-10>,
  "feedback": "<2-3 sentences: start with what was strong, then note what could be sharper>",
  "passed": <true if score >= 7>
}`;

  } else {
    return NextResponse.json({ error: "Invalid phase" }, { status: 400 });
  }

  // Scoring (evaluate) needs Sonnet's judgment; the in-character open/respond
  // lines are short conversational gen — Haiku handles those at 1/5 the cost.
  // Bound once so the usage log records the model that actually ran.
  const model = phase === "evaluate" ? "claude-sonnet-4-6" : "claude-haiku-4-5";

  const startedAt = Date.now();

  // Wrapped so an SDK throw is recorded rather than becoming an unhandled 500
  // that leaves no trace — the shape every sibling route already uses.
  try {
    const completion = await createTextMessage(anthropic, userId, "mastery/session", {
      model,
      max_tokens: phase === "evaluate" ? 512 : 256,
      messages:   [{ role: "user", content: prompt }],
    });

    const raw = (completion.content[0] as { type: string; text: string }).text.trim();

    void logUsage({ userId, model, feature: "mastery/session", tokensIn: completion.usage.input_tokens, tokensOut: completion.usage.output_tokens });

    if (phase === "evaluate") {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      try {
        const result = JSON.parse(cleaned) as { score: number; feedback: string; passed: boolean };
        void recordOperation({
          userId, operation: "mastery.session", outcome: "ok",
          durationMs: Date.now() - startedAt, detail: { phase },
        });
        return NextResponse.json({ ...result, feedback: stripEmphasis(result.feedback) });
      } catch {
        console.error("[mastery/session] Failed to parse evaluate JSON:", cleaned);
        void recordOperation({
          userId, operation: "mastery.session", outcome: "failed",
          durationMs: Date.now() - startedAt, detail: { phase, stage: "parse" },
        });
        return NextResponse.json({ error: "Failed to parse evaluation" }, { status: 500 });
      }
    }

    void recordOperation({
      userId, operation: "mastery.session", outcome: "ok",
      durationMs: Date.now() - startedAt, detail: { phase },
    });
    return NextResponse.json({ text: stripEmphasis(raw) });
  } catch (err) {
    const refusal = textBudgetResponse(err);
    if (refusal) {
      void recordOperation({ userId: userId, operation: "mastery.session", outcome: "refused", detail: { reason: "text-admission" } });
      return refusal;
    }
    console.error("[mastery/session] Anthropic error:", err);
    void recordOperation({
      userId, operation: "mastery.session", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err, detail: { phase },
    });
    return NextResponse.json({ error: "Failed to run the session." }, { status: 502 });
  }
}
