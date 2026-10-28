import { type NextRequest, NextResponse } from "next/server";
import { claudeClient } from "@/lib/claude/client";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { createServiceClient } from "@/lib/supabase/service";
import { checkUsageAllowed, logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { SAMPLE_DRILL, type DrillContent } from "@/lib/code/drillContent";
import { buildDrillPrompt, parseDrill, drillCacheKey, DRILL_SYSTEM, type DrillRequest } from "@/lib/code/generateDrill";

// Turns the learning/topic a user picked on /code/start into a runnable, pure-
// Python notebook drill. Sonnet — reasoning-heavy generation where quality
// matters (see Model Selection in CLAUDE.md). Server-side only.
//
// Generated drills are cached in `code_drills` (keyed by topic, shared across
// users) so a repeat visit is an instant lookup instead of a fresh ~3–6s LLM
// call. Every cache op is best-effort: if the table is missing or a query fails,
// we just generate live. On any generation failure we return the sample drill
// with generated:false so the drill screen always has something to render.
const anthropic = claudeClient();

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-sonnet-4-6";

const sample = (reason: string) =>
  NextResponse.json({ content: SAMPLE_DRILL, generated: false, reason });

// Look up a previously generated drill. Returns null on miss OR any error
// (missing table, network) — the caller then generates live.
async function readCache(key: string): Promise<DrillContent | null> {
  try {
    const db = createServiceClient();
    const { data, error } = await db.from("code_drills").select("content").eq("cache_key", key).maybeSingle();
    if (error || !data) return null;
    return data.content as DrillContent;
  } catch (e) {
    console.error("[code/generate-drill] cache read failed:", e);
    return null;
  }
}

// Store a generated drill. Best-effort — a failure (missing table, race) never
// blocks the response.
async function writeCache(key: string, req: DrillRequest, content: DrillContent): Promise<void> {
  try {
    const db = createServiceClient();
    await db.from("code_drills").upsert(
      { cache_key: key, topic: req.topic, context: req.context ?? null, focus: req.focus ?? null, content },
      { onConflict: "cache_key", ignoreDuplicates: true },
    );
  } catch (e) {
    console.error("[code/generate-drill] cache write failed:", e);
  }
}

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return sample("not-signed-in");

  const body = (await request.json().catch(() => ({}))) as Partial<DrillRequest>;
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (!topic) return sample("no-topic");

  const req: DrillRequest = {
    topic: topic.slice(0, 200),
    context: typeof body.context === "string" ? body.context.slice(0, 200) : undefined,
    focus: typeof body.focus === "string" ? body.focus.slice(0, 120) : undefined,
  };

  // Cache hit → serve instantly (no LLM call, so no usage charged).
  //
  // Deliberately NOT recorded: `code.drill` counts attempts to GENERATE, and a
  // cache hit generated nothing. Counting it as 'ok' would pad the success rate
  // with work that never ran, and hide a generator that had stopped working
  // behind a warm cache.
  const key = drillCacheKey(req);
  const cached = await readCache(key);
  if (cached) return NextResponse.json({ content: cached, generated: true, cached: true });

  // Miss → generation is the billable path, so gate on usage here.
  const { allowed } = await checkUsageAllowed(userId, "code/generate-drill");
  if (!allowed) {
    void recordOperation({
      userId, operation: "code.drill", outcome: "refused",
      detail: { reason: "usage-limit" },
    });
    return sample("usage-limit");
  }

  const startedAt = Date.now();

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: DRILL_SYSTEM,
      messages: [{ role: "user", content: buildDrillPrompt(req) }],
    });
    void logUsage({ userId, model: MODEL, feature: "code/generate-drill", tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens });

    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    const content = parseDrill(text); // throws on any shape problem
    await writeCache(key, req, content);
    void recordOperation({
      userId, operation: "code.drill", outcome: "ok",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ content, generated: true, cached: false });
  } catch (err) {
    console.error("[code/generate-drill] falling back to sample:", err);
    // This row is the ONLY evidence the generation failed. The learner is
    // handed SAMPLE_DRILL and practises something real, so nobody will ever
    // report it — see `failureIsSilent` on code.drill.
    void recordOperation({
      userId, operation: "code.drill", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err, redact: [req.topic],
    });
    return sample("generation-failed");
  }
}
