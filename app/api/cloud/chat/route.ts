import { readTextRequest } from "@/lib/claude/textRequest";
import { createTextMessage, textBudgetResponse } from "@/lib/claude/textBudget";
import { type NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { loadService } from "@/lib/cloud/loader";
import { GROUP_LABELS } from "@/types/cloud";

// Scoped assistant for a Cloud Skills service page. Haiku — the job is short,
// grounded Q&A about one cloud service, not heavy reasoning (see Model Selection
// in CLAUDE.md). Server-side only; the browser never sees the API key. The
// service's own facts are loaded here and injected into the system prompt so
// answers stay grounded and on-domain rather than free-associating.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-haiku-4-5";

const BASE_SYSTEM = `You are Hugh, a friendly, concise cloud-skills tutor for a data/analytics learner.
- Keep it short and plain-spoken: a few sentences, a tight list only when it helps. No preamble, no lecturing.
- Ground your answers in the SERVICE FACTS provided. If the learner asks something the facts don't cover, use your general knowledge but say so briefly, and never invent specific limits or prices.
- Stay on data engineering / analytics / cloud topics. If asked something off-topic, gently steer back.
- When comparing clouds, be even-handed and concrete about the real differences.`;

/** Build a compact, grounded context block from the service's own JSON. */
function serviceContext(s: NonNullable<Awaited<ReturnType<typeof loadService>>>): string {
  const groups = s.groups.map((g) => GROUP_LABELS[g]).join(", ");
  const concepts = s.coreConcepts.map((c) => `- ${c.term}: ${c.detail}`).join("\n");
  const facts = s.keyFacts.map((f) => `- ${f.label}: ${f.value}`).join("\n");
  const equivalents = s.equivalents
    .map((e) => `- ${e.provider.toUpperCase()} ${e.name}${e.note ? ` (${e.note})` : ""}`)
    .join("\n");
  return [
    `SERVICE FACTS — the learner is viewing this service:`,
    `Name: ${s.name}${s.short ? ` (${s.short})` : ""}`,
    `Cloud: ${s.provider.toUpperCase()}`,
    `Groups: ${groups}`,
    `Summary: ${s.oneLiner}`,
    `What it is: ${s.whatItIs}`,
    ...(s.inPractice
      ? [
          `Where it fits (illustrative): ${s.inPractice.narrative}` +
            (s.inPractice.flow ? `\nTypical pipeline: ${s.inPractice.flow.join(" → ")}` : ""),
        ]
      : []),
    `Core concepts:\n${concepts}`,
    `When to use: ${s.whenToUse.join("; ")}`,
    `When not to use: ${s.whenNotToUse.join("; ")}`,
    `Key facts:\n${facts}`,
    `Pricing shape: ${s.pricingShape}`,
    `Gotchas: ${s.gotchas.join("; ")}`,
    `Cross-cloud equivalents:\n${equivalents}`,
  ].join("\n");
}

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Please sign in to use the assistant." }, { status: 401 });

  const input = await readTextRequest(request, "cloud");
  if (input.response) return input.response;
  const body = input.body;
  const messages = body.messages;
  if (messages.length === 0) return NextResponse.json({ error: "messages required" }, { status: 400 });
  if (!body.provider || !body.serviceId) {
    return NextResponse.json({ error: "provider and serviceId required" }, { status: 400 });
  }

  const service = await loadService(body.provider, body.serviceId);
  if (!service) return NextResponse.json({ error: "Unknown service." }, { status: 404 });

  const startedAt = Date.now();

  try {
    const res = await createTextMessage(anthropic, userId, "cloud/chat", {
      model: MODEL,
      max_tokens: 600,
      system: `${BASE_SYSTEM}\n\n${serviceContext(service)}`,
      messages,
    });
    const reply = res.content[0]?.type === "text" ? res.content[0].text : "";
    void logUsage({ userId, model: MODEL, feature: "cloud/chat", tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens });
    // Voided, not awaited: the learner is waiting on the reply, and a lost row
    // costs one data point where an added round trip costs every request.
    void recordOperation({
      userId, operation: "cloud.chat", outcome: "ok",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ reply: reply || "Sorry — please try again." });
  } catch (err) {
    const refusal = textBudgetResponse(err);
    if (refusal) {
      void recordOperation({ userId: userId, operation: "cloud.chat", outcome: "refused", detail: { reason: "text-admission" } });
      return refusal;
    }
    console.error("[cloud/chat] Claude error:", err);
    void recordOperation({
      userId, operation: "cloud.chat", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err,
    });
    return NextResponse.json({ error: "Failed to generate a response." }, { status: 502 });
  }
}
