import { type NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { requireAdminApi } from "@/lib/auth/requireAdmin";
import rawData from "@/lib/architecture/data.generated.json";

export const dynamic = "force-dynamic";

interface ArchComponent {
  path: string;
  loc: number;
  fanIn: number;
  fanOut: number;
  complexity: number;
  churn: number;
  hotspotScore: number;
}
interface ArchChange { hash: string; date: string; subject: string; files: string[] }
interface ArchData {
  generatedAt: string;
  components: ArchComponent[];
  edges: { from: string; to: string }[];
  recentChanges: ArchChange[];
}

interface ChatMessage { role: "user" | "assistant"; content: string }

const data = rawData as ArchData;

/**
 * Grounds the assistant ONLY in the current scan snapshot — components,
 * hotspots, dependency counts, and recent changes. No filesystem/git access
 * (this runs on serverless), so it can't leak source or secrets.
 */
function buildSystemPrompt(): string {
  const top = data.components
    .slice(0, 15)
    .map((c) => `${c.path} — hotspot ${c.hotspotScore}, LOC ${c.loc}, complexity ${c.complexity} (in ${c.fanIn}/out ${c.fanOut}), churn ${c.churn}`)
    .join("\n");
  const all = data.components
    .map((c) => `${c.path} [loc ${c.loc}, cplx ${c.complexity}, in ${c.fanIn}, out ${c.fanOut}, churn ${c.churn}, hot ${c.hotspotScore}]`)
    .join("\n");
  const changes = data.recentChanges
    .slice(0, 15)
    .map((c) => `${c.hash} ${String(c.date).slice(0, 10)} — ${c.subject} (${c.files.length} files)`)
    .join("\n");

  return [
    "You are the Hugh Architecture Assistant, embedded in the admin dashboard.",
    "Hugh is a Next.js 16 (App Router) app — Supabase (Postgres + Auth), Anthropic Claude, OpenAI Realtime voice, Tailwind. Source roots: app/, components/, hooks/, lib/, types/, utils/.",
    "Answer questions about Hugh's architecture using ONLY the scan data below: components, hotspots (churn × complexity, 0–100), dependency counts (fan-in/out), and recent changes. Be concise and concrete, lead with the answer, and cite real file paths. If something isn't in this data, say so plainly rather than guessing.",
    `\nScan generated: ${data.generatedAt}`,
    `Files: ${data.components.length}, dependency edges: ${data.edges.length}`,
    `\nTop hotspots:\n${top}`,
    `\nAll components:\n${all}`,
    `\nRecent changes:\n${changes}`,
  ].join("\n");
}

export async function POST(request: NextRequest) {
  const gate = await requireAdminApi();
  if (gate instanceof NextResponse) return gate;

  const body = (await request.json()) as { messages?: ChatMessage[] };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return NextResponse.json({ error: "messages required" }, { status: 400 });
  }

  // Instantiate the client per request (not at module scope) so the build never
  // needs the key — this admin assistant is optional and OPENAI_API_KEY isn't
  // set in every deployment. Missing key → a graceful 503, not a build crash.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "The architecture assistant isn't configured on this deployment (missing OPENAI_API_KEY)." },
      { status: 503 },
    );
  }
  const openai = new OpenAI({ apiKey });

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1024,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        ...messages.slice(-20),
      ],
    });

    const reply = res.choices[0]?.message?.content ?? "";
    return NextResponse.json({ reply: reply || "I couldn't generate a response. Please try again." });
  } catch (err) {
    console.error("[architecture/chat] OpenAI error:", err);
    return NextResponse.json({ error: "Failed to generate response" }, { status: 502 });
  }
}
