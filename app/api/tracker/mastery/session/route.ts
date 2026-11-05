import { readTextRequest } from "@/lib/claude/textRequest";
import { createTextMessage, textBudgetResponse } from "@/lib/claude/textBudget";
import { type NextRequest, NextResponse } from "next/server";
import { claudeClient } from "@/lib/claude/client";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { writeOutcome } from "@/lib/supabase/writeResult";
import { logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { stripEmphasis } from "@/lib/claude/prompts";
import type { SessionMessage } from "@/lib/claude/textInput";
import { correctionText, misconceptionCorrections } from "@/lib/packs/grounding";
import { masteryOutcome, type MasteryRecord, type MasteryWrite } from "@/lib/mastery/outcome";
import {
  cardMisconceptions, cardTopics, coverageFeedback, coverageScore, coverageSummary, topicsForBrowser,
  type CardTopics,
} from "@/lib/mastery/topics";
import { applyTurnCheck, MAX_TURNS, parseTurnCheck, turnCheckPrompt } from "@/lib/mastery/turnCheck";

const anthropic = claudeClient();

// One call per turn does the check and writes Hugh's line. The check decides a
// result, so it gets the model that does the scoring elsewhere.
const MODEL = "claude-sonnet-4-6";

interface CardRow {
  id:                string;
  title:             string;
  mastery_validated: boolean;
  concept_ids:       string[] | null;
  learning_points:   unknown;
  tracks:            { user_id: string } | null;
}

interface SessionRow {
  id:           string;
  milestone_id: string;
  topic_refs:   string[];
  covered:      string[];
  held:         string[];
  turns:        number;
  finished_at:  string | null;
}

type Loaded<T> = { ok: true; value: T } | { ok: false; response: NextResponse };
const refused = <T>(error: string, status: number): Loaded<T> => ({ ok: false, response: NextResponse.json({ error }, { status }) });

// RLS already hides other learners' rows from this read; the explicit check is
// the second lock, because a result is recorded with the service role, where
// RLS does not apply.
async function loadOwnedCard(milestoneId: string, userId: string): Promise<Loaded<CardRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("milestones")
    .select("id, title, mastery_validated, concept_ids, learning_points, tracks!track_id!inner(user_id)")
    .eq("id", milestoneId)
    .maybeSingle();
  if (error) {
    console.error("[mastery/session] milestone lookup error:", error.message);
    return refused("Couldn't load this card. Please try again.", 500);
  }
  const card = data as unknown as CardRow | null;
  if (!card || card.tracks?.user_id !== userId) return refused("Milestone not found", 404);
  return { ok: true, value: card };
}

async function loadOwnSession(sessionId: string, userId: string): Promise<Loaded<SessionRow>> {
  const { data, error } = await createServiceClient()
    .from("mastery_sessions")
    .select("id, milestone_id, topic_refs, covered, held, turns, finished_at")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[mastery/session] session lookup error:", error.message);
    return refused("Couldn't load this session. Please try again.", 500);
  }
  if (!data) return refused("Session not found", 404);
  return { ok: true, value: data as unknown as SessionRow };
}

function topicsOrRefusal(found: CardTopics): Loaded<Extract<CardTopics, { kind: "ok" }>> {
  // A course card whose pack cannot be taught is refused in its own words, never scored ungrounded.
  if (found.kind === "refused") return refused(found.message, 503);
  if (found.kind === "missing") return refused("This card's topics aren't ready yet. Please try again.", 409);
  return { ok: true, value: found };
}

/** The learner's notes, which an older card is judged against. A course card has its syllabus instead. */
async function loadNotes(milestoneId: string): Promise<Loaded<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("milestone_entries")
    .select("title, body")
    .eq("milestone_id", milestoneId)
    .order("created_at", { ascending: true })
    .limit(65);
  if (error) {
    console.error("[mastery/session] notes lookup error:", error.message);
    return refused("Couldn't load your notes. Please try again.", 500);
  }
  if (!data || data.length === 0) return refused("No diary entries found", 422);
  if (data.length > 64) return refused("Too many notes for one assessment. Use a smaller milestone.", 413);
  return {
    ok: true,
    value: data.map((e, i) => `[Entry ${i + 1}]${e.title ? ` ${e.title}` : ""}\n${e.body ?? ""}`).join("\n\n"),
  };
}

/**
 * Write a scored result. Since migration 058 a learner's own session cannot
 * write mastery results, so the server records them with the service role.
 * A failed write is reported, never thrown: the score is still real, and the
 * page has to say it was not saved.
 */
async function recordMasteryResult(milestoneId: string, write: MasteryWrite): Promise<MasteryRecord> {
  const { error } = await createServiceClient()
    .from("milestones")
    .update(write)
    .eq("id", milestoneId);
  if (error) {
    console.error("[mastery/session] Failed to record result:", error.message);
    return "failed";
  }
  return "saved";
}

/** Begin a session: no model call, just the card's list and a row to hold the ticks. */
async function startSession(userId: string, milestoneId: string): Promise<NextResponse> {
  const card = await loadOwnedCard(milestoneId, userId);
  if (!card.ok) return card.response;
  const found = topicsOrRefusal(cardTopics(card.value.concept_ids, card.value.learning_points));
  if (!found.ok) return found.response;

  const supabase = await createClient();
  const { count, error: countError } = await supabase
    .from("milestone_entries")
    .select("id", { count: "exact", head: true })
    .eq("milestone_id", milestoneId);
  if (countError) {
    console.error("[mastery/session] notes count error:", countError.message);
    return NextResponse.json({ error: "Couldn't load your notes. Please try again." }, { status: 500 });
  }
  if (!count) return NextResponse.json({ error: "No diary entries found" }, { status: 422 });

  const service = createServiceClient();
  // One live session per card: starting again abandons the last attempt, so
  // ticks never carry over. A pass is earned in one sitting.
  const { error: clearError } = await service
    .from("mastery_sessions")
    .delete()
    .eq("user_id", userId)
    .eq("milestone_id", milestoneId)
    .is("finished_at", null);
  if (clearError) {
    console.error("[mastery/session] Failed to clear the last attempt:", clearError.message);
    return NextResponse.json({ error: "Couldn't start the session. Please try again." }, { status: 500 });
  }

  const { data, error } = await service
    .from("mastery_sessions")
    .insert({ user_id: userId, milestone_id: milestoneId, topic_refs: found.value.topics.map(t => t.ref) })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[mastery/session] Failed to start a session:", error?.message);
    void recordOperation({ userId, operation: "mastery.session", outcome: "failed", detail: { phase: "start", stage: "store" } });
    return NextResponse.json({ error: "Couldn't start the session. Please try again." }, { status: 500 });
  }

  void recordOperation({ userId, operation: "mastery.session", outcome: "ok", detail: { phase: "start" } });
  return NextResponse.json({
    sessionId: (data as { id: string }).id,
    topics:    topicsForBrowser(found.value.topics),
    turnsLeft: MAX_TURNS,
  });
}

/** Check one turn against the topics still open, and hold what it earned. */
async function takeTurn(userId: string, sessionId: string, said: string, recent: SessionMessage[]): Promise<NextResponse> {
  const loaded = await loadOwnSession(sessionId, userId);
  if (!loaded.ok) return loaded.response;
  const session = loaded.value;
  if (session.finished_at) return NextResponse.json({ error: "This session has already finished." }, { status: 409 });
  if (session.turns >= MAX_TURNS) return NextResponse.json({ error: "This session has used all its turns. Press Finish." }, { status: 409 });

  const card = await loadOwnedCard(session.milestone_id, userId);
  if (!card.ok) return card.response;
  const found = topicsOrRefusal(cardTopics(card.value.concept_ids, card.value.learning_points));
  if (!found.ok) return found.response;

  // The list as it stood when the session began, so the share cannot shift under it.
  const inSession = new Set(session.topic_refs);
  const topics    = found.value.topics.filter(t => inSession.has(t.ref));
  const ticked    = new Set(session.covered);
  const open      = topics.filter(t => !ticked.has(t.ref));
  const beliefs   = cardMisconceptions(found.value.ground).map(m => ({ ref: m.ref, claim: m.claim }));
  const turnsLeft = MAX_TURNS - session.turns;

  // Nothing left to judge, so nothing to spend.
  if (open.length === 0 && session.held.length === 0) {
    return NextResponse.json({ reply: "That's every topic. Press Finish when you're ready.", covered: session.covered, heldCount: 0, turnsLeft });
  }

  let notes: string | null = null;
  if (!found.value.ground) {
    const loadedNotes = await loadNotes(session.milestone_id);
    if (!loadedNotes.ok) return loadedNotes.response;
    notes = loadedNotes.value;
  }

  const startedAt = Date.now();
  try {
    const completion = await createTextMessage(anthropic, userId, "mastery/session", {
      model:      MODEL,
      max_tokens: 1024,
      messages:   [{ role: "user", content: turnCheckPrompt({
        cardTitle: card.value.title, open, beliefs, held: session.held, notes, recent, said,
      }) }],
    });
    void logUsage({ userId, model: MODEL, feature: "mastery/session", tokensIn: completion.usage.input_tokens, tokensOut: completion.usage.output_tokens });

    const first = completion.content[0];
    const check = parseTurnCheck(first?.type === "text" ? first.text : "");
    if (!check) {
      console.error("[mastery/session] Failed to parse a turn check");
      void recordOperation({
        userId, operation: "mastery.session", outcome: "failed",
        durationMs: Date.now() - startedAt, detail: { phase: "turn", stage: "parse" },
      });
      return NextResponse.json({ error: "Hugh couldn't check that." }, { status: 502 });
    }

    const applied = applyTurnCheck({ covered: session.covered, held: session.held }, check, said, topics, beliefs);

    // Conditional on the turn count, so a double-send cannot count one turn twice.
    const stored = writeOutcome(
      await createServiceClient()
        .from("mastery_sessions")
        .update({ covered: applied.covered, held: applied.held, turns: session.turns + 1 })
        .eq("id", session.id)
        .eq("turns", session.turns)
        .select("id")
        .maybeSingle(),
    );
    if (!stored.ok) {
      console.error("[mastery/session] Failed to hold a turn:", stored.message);
      void recordOperation({
        userId, operation: "mastery.session", outcome: "failed",
        durationMs: Date.now() - startedAt, detail: { phase: "turn", stage: "store", reason: stored.reason },
      });
      return stored.reason === "no-row"
        ? NextResponse.json({ error: "Hugh was already checking that." }, { status: 409 })
        : NextResponse.json({ error: "Hugh checked that but couldn't save it." }, { status: 500 });
    }

    // Counts only. A rising `rejected` means the check is drifting, and the learner's words stay out of it.
    void recordOperation({
      userId, operation: "mastery.session", outcome: "ok",
      durationMs: Date.now() - startedAt, detail: { phase: "turn", rejected: applied.rejected },
    });
    return NextResponse.json({
      reply:     stripEmphasis(check.reply),
      covered:   applied.covered,
      heldCount: applied.held.length,
      turnsLeft: turnsLeft - 1,
    });
  } catch (err) {
    const refusal = textBudgetResponse(err);
    if (refusal) {
      void recordOperation({ userId, operation: "mastery.session", outcome: "refused", detail: { reason: "text-admission" } });
      return refusal;
    }
    console.error("[mastery/session] Anthropic error:", err);
    void recordOperation({
      userId, operation: "mastery.session", outcome: "failed",
      durationMs: Date.now() - startedAt, error: err, detail: { phase: "turn" },
    });
    return NextResponse.json({ error: "Hugh couldn't check that." }, { status: 502 });
  }
}

/** Add it up. No model call: the same ticks always give the same result. */
async function finishSession(userId: string, sessionId: string): Promise<NextResponse> {
  const loaded = await loadOwnSession(sessionId, userId);
  if (!loaded.ok) return loaded.response;
  const session = loaded.value;
  if (session.finished_at) return NextResponse.json({ error: "This session has already finished." }, { status: 409 });
  // Otherwise opening a practice run and leaving would replace a real score with the lowest one.
  if (session.turns === 0) return NextResponse.json({ error: "Say something first, so Hugh has something to check." }, { status: 409 });

  const card = await loadOwnedCard(session.milestone_id, userId);
  if (!card.ok) return card.response;
  const found = topicsOrRefusal(cardTopics(card.value.concept_ids, card.value.learning_points));
  if (!found.ok) return found.response;

  const inSession = new Set(session.topic_refs);
  const topics    = found.value.topics.filter(t => inSession.has(t.ref));
  const score     = coverageScore(session.covered.length, session.topic_refs.length);
  // A held wrong belief gets the course's own correction and source, written
  // from the pack rather than by a model.
  const corrections = found.value.ground ? misconceptionCorrections(found.value.ground, session.held) : [];
  const feedback    = coverageFeedback(topics, session.covered, corrections.map(correctionText));
  const outcome     = masteryOutcome({ score, feedback, misconceptionsHeld: session.held }, card.value.mastery_validated);
  const record: MasteryRecord = outcome.write ? await recordMasteryResult(session.milestone_id, outcome.write) : "skipped";

  // Left open when the result did not save, so pressing again can save it
  // without a word of the session being repeated.
  if (record !== "failed") {
    const { error } = await createServiceClient()
      .from("mastery_sessions")
      .update({ finished_at: new Date().toISOString() })
      .eq("id", session.id);
    // The result is safe by now; the row only stops further turns, and it expires anyway.
    if (error) console.error("[mastery/session] Failed to close a session:", error.message);
  }

  void recordOperation({
    userId, operation: "mastery.session", outcome: record === "failed" ? "failed" : "ok",
    detail: record === "failed" ? { phase: "finish", record, stage: "record" } : { phase: "finish", record },
  });
  // In parts, because the screen shows them differently from what the card keeps.
  return NextResponse.json({
    score, ...coverageSummary(topics, session.covered), corrections, covered: session.covered,
    passed: outcome.passed, record,
  });
}

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const input = await readTextRequest(request, "session");
  if (input.response) return input.response;
  const body = input.body;

  switch (body.phase) {
    case "start":  return startSession(userId, body.milestoneId);
    case "turn":   return takeTurn(userId, body.sessionId, body.said, body.recent);
    case "finish": return finishSession(userId, body.sessionId);
    default:       return NextResponse.json({ error: "Invalid phase" }, { status: 400 });
  }
}
