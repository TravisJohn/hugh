import type { TextCall, TextCallGuard } from "@/lib/claude/textInput";
import Anthropic from "@anthropic-ai/sdk";
import { type SupabaseClient } from "@supabase/supabase-js";
import { backlogPriorityPrompt, parseClaudeJson } from "@/lib/claude/prompts";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for this call — see CLAUDE.md "Model Selection". Returned to the
// caller alongside the token counts so it can log what was actually billed.
const MODEL = "claude-sonnet-4-6";

/** One milestone's final place in the suggested build order. */
export interface PriorityAssignment {
  id:     string;
  rank:   number;
  reason: string | null;
}

export interface PriorityResult {
  inputTokens:  number;
  outputTokens: number;
  model:        string;
  /**
   * What was written, returned so the caller can snapshot the board as the
   * learner receives it. Ranking happens by UPDATE after the milestone insert,
   * so it is absent from the generation parse entirely — a provenance snapshot
   * taken from that parse would record a curriculum with no order in it, and
   * ordering is most of what makes a curriculum good or bad.
   */
  assignments:  PriorityAssignment[];
}

/**
 * One-time agentic ranking of a track's backlog milestones. Claude reasons
 * through dependencies and returns a logical build order; we write each card's
 * `priority_rank` (1-based) and a one-line `priority_reason`.
 *
 * Deliberately has NO server-only imports so it can run from a backfill script
 * as well as from generateTrack. Caller is responsible for logging usage.
 * Returns null when there are no backlog milestones.
 */
export async function assignBacklogPriority(
  supabase: SupabaseClient,
  trackId:  string,
  topic:    string,
  beforeCall?: TextCallGuard,
): Promise<PriorityResult | null> {
  const { data: rows } = await supabase
    .from("milestones")
    .select("id, title, summary")
    .eq("track_id", trackId)
    .eq("kanban_column", "backlog")
    .order("position", { ascending: true });

  const milestones = (rows ?? []) as Array<{ id: string; title: string; summary: string }>;
  if (milestones.length === 0) return null;

  const items = milestones.map((m, i) => ({ n: i + 1, title: m.title, summary: m.summary }));

  const call: TextCall = {
    model: MODEL, max_tokens: 1200,
    messages: [{ role: "user", content: backlogPriorityPrompt(topic, items) }],
  };
  await beforeCall?.(call);
  const res = await anthropic.messages.create(call, beforeCall ? { maxRetries: 0 } : undefined);

  const raw    = res.content[0]?.type === "text" ? res.content[0].text : "{}";
  const parsed = parseClaudeJson<{ ordered: Array<{ n: number; reason: string }> }>(raw);

  // Build rank assignments from Claude's order; guard ranges + de-dupe.
  const seen = new Set<number>();
  const assignments: PriorityAssignment[] = [];
  let rank = 1;
  for (const entry of parsed.ordered ?? []) {
    const idx = entry.n - 1;
    if (idx < 0 || idx >= milestones.length || seen.has(entry.n)) continue;
    seen.add(entry.n);
    assignments.push({ id: milestones[idx].id, rank: rank++, reason: entry.reason?.trim() || null });
  }
  // Append any milestones Claude omitted, preserving their original order.
  milestones.forEach((m, i) => {
    if (!seen.has(i + 1)) assignments.push({ id: m.id, rank: rank++, reason: null });
  });

  await Promise.all(assignments.map(a =>
    supabase
      .from("milestones")
      .update({ priority_rank: a.rank, priority_reason: a.reason })
      .eq("id", a.id)
  ));

  return {
    inputTokens:  res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    model:        MODEL,
    assignments,
  };
}
