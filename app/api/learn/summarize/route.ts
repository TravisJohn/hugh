import { readTextRequest } from "@/lib/claude/textRequest";
import { createTextMessage, textBudgetResponse } from "@/lib/claude/textBudget";
import "server-only";
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { sanitizeCovered } from "@/lib/learn/sessionRecord";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-sonnet-4-6";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const input = await readTextRequest(req, "summary");
  if (input.response) return input.response;
  const body = input.body;

  const { topic, messages } = body;
  if (!topic || !messages?.length) {
    return NextResponse.json({ error: "Missing topic or messages" }, { status: 400 });
  }

  // The browser removes its synthetic welcome. Preserve all submitted evidence;
  // an assistant-first transcript is not proof that its first turn is a greeting.
  const conversation = messages
    .map(m => `${m.role === "user" ? "Student" : "Hugh"}: ${m.content}`)
    .join("\n\n");

  const prompt = `You are reviewing a learning conversation about "${topic}".

CONVERSATION:
${conversation}

Write a SHORT narrative (3-4 sentences) describing how this conversation unfolded — what the student explored, what key ideas emerged, and how the discussion progressed. Write it as a flowing story, not a list.

Then choose ONE key takeaway that is most relevant and most impactful for the topic "${topic}". This should be the single insight the student should remember above all else.

Then generate a SHORT, specific title (4-7 words) that captures the MAIN concept discussed in this specific conversation — not just the general subject, but what was actually explored. Examples: "Partitioning Strategies for Large Fact Tables", "Why Idempotency Matters in Pipelines".

Then record what the conversation actually ESTABLISHED, as a list of points. This is a record of substance, not of subjects: it is later the only source a review quiz may draw on, so anything missing here can never be asked about, and anything wrongly included will be asked about despite never being covered.

Return ONLY valid JSON with exactly these four fields:
{"story": "...", "takeaway": "...", "title": "...", "covered": [{"point": "...", "detail": "..."}]}

Rules:
- "story" must be 3-4 flowing sentences, no bullet points
- "takeaway" must be a single concise sentence (20 words max)
- "title" must be 4-7 words, specific to what was discussed
- "covered" must have 3-10 items, ordered as the conversation reached them
- each "point" is a short label (3-8 words); each "detail" is 1-3 sentences stating the substance in full — the claim, the rule, the worked reasoning — so it stands on its own months later
- write "detail" as the thing itself, NOT as a description of the discussion. Write "A feature vector and a weight vector must have the same length for their dot product to be defined." Never "The student explored how dot products work."
- include a point ONLY if it was actually stated or worked through in the conversation above. If a subject was named in passing but never explained, leave it out. Do not add standard knowledge of the topic that the conversation did not cover.
- Do not use markdown inside the JSON values
- Return ONLY the JSON object, no fences, no commentary`;

  const startedAt = Date.now();

  try {
    const response = await createTextMessage(anthropic, user.id, "learn/summarize", {
      model:      MODEL,
      // Raised for "covered": the narrative alone fitted in 512, the record of
      // substance does not.
      max_tokens: 2048,
      messages:   [{ role: "user", content: prompt }],
    });

    const block = response.content[0];
    if (block.type !== "text") {
      void recordOperation({
        userId: user.id, operation: "ask.summarize", outcome: "failed",
        durationMs: Date.now() - startedAt, detail: { stage: "non-text-block" },
      });
      return NextResponse.json({ error: "Unexpected response type" }, { status: 500 });
    }

    void logUsage({ userId: user.id, model: MODEL, feature: "learn/summarize", tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens });

    const raw    = block.text.trim().replace(/^```(?:json)?|```$/g, "").trim();
    const parsed = JSON.parse(raw) as {
      story: string; takeaway: string; title?: string; covered?: unknown;
    };

    void recordOperation({
      userId: user.id, operation: "ask.summarize", outcome: "ok",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({
      story:    parsed.story,
      takeaway: parsed.takeaway,
      title:    parsed.title ?? null,
      covered:  sanitizeCovered(parsed.covered),
    });
  } catch (err) {
    const refusal = textBudgetResponse(err);
    if (refusal) {
      void recordOperation({ userId: user.id, operation: "ask.summarize", outcome: "refused", detail: { reason: "text-admission" } });
      return refusal;
    }
    // A run of failures here starves review quizzes of material, because only
    // a saved diary entry can be quoted by one.
    void recordOperation({
      userId: user.id, operation: "ask.summarize", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err, redact: [topic],
    });
    return NextResponse.json({ error: "Failed to generate summary" }, { status: 500 });
  }
}
