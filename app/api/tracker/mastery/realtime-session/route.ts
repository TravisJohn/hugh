import { after, type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { enforceUsageGate } from "@/lib/usage";
import { canUseRealtime } from "@/lib/mastery/realtimeAccess";
import { logSafeError } from "@/lib/observability/log";
import { periodStart } from "@/lib/tokenBudget";
import { attachSideband, callIdFromLocation, hangupCall, monitorCall, SESSION_RESERVE_USD, SESSION_USER_BUDGET_USD, SESSION_WORKSPACE_BUDGET_USD, SESSION_USER_CONCURRENCY, SESSION_WORKSPACE_CONCURRENCY } from "@/lib/mastery/liveVoiceControl";
import type { LearningPoint } from "@/types";
import {
  buildCriteria,
  renderCriteriaForPrompt,
  prepareDiaryContext,
} from "@/lib/mastery/criteria";
import { buildGuidedCoachInstructions } from "@/lib/mastery/masteryInstructions";
import {
  REALTIME_MODEL,
  REALTIME_TRANSCRIPTION_MODEL,
  TRANSCRIPTION_LANGUAGE,
  TURN_DETECTION,
  MASTERY_VOICE,
  MAX_SESSION_SECONDS,
  MAX_RESPONSE_OUTPUT_TOKENS,
  MAX_CONTEXT_TOKENS,
  MAX_FOLLOWUPS,
  INACTIVITY_MS,
  MAX_DIARY_CHARS,
} from "@/lib/mastery/realtimeConfig";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 240;

// Creates the provider call on the server, binds its ID to the authenticated
// user and keeps a sideband observer alive for the entire short preview.

function realtimeEnabled(): boolean {
  return process.env.MASTERY_REALTIME_ENABLED === "true";
}

export async function POST(request: NextRequest) {
  if (!realtimeEnabled()) {
    return NextResponse.json({ error: "Realtime mastery is not enabled." }, { status: 404 });
  }

  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Enforce at credential issuance, not just in the page. Paid/approved learner
  // status and client-supplied claims never grant this administrator preview.
  const supabase = await createClient();
  let usagePeriodStart = periodStart(null);
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("is_admin, is_blocked, usage_reset_at")
      .eq("user_id", userId)
      .single();
    if (error) {
      logSafeError("mastery/realtime-session access", error);
      return NextResponse.json({ error: "Realtime access checks are temporarily unavailable. Try again shortly." }, { status: 503 });
    }
    if (!canUseRealtime(process.env.MASTERY_REALTIME_ENABLED, profile)) {
      return NextResponse.json({ error: "Realtime voice is currently an administrator preview." }, { status: 403 });
    }
    usagePeriodStart = periodStart(profile);
  } catch (error) {
    logSafeError("mastery/realtime-session access", error);
    return NextResponse.json({ error: "Realtime access checks are temporarily unavailable. Try again shortly." }, { status: 503 });
  }

  const usageGate = await enforceUsageGate(userId, "mastery/realtime");
  if (usageGate) return usageGate;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Realtime voice is temporarily unavailable." }, { status: 503 });
  }
  const db = createServiceClient();
  const { data: recoveryReady, error: recoveryError } = await db.rpc("mastery_realtime_recovery_ready");
  if (recoveryError || recoveryReady !== true || !process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Realtime recovery is not configured." }, { status: 503 });
  }

  let body: { milestoneId?: unknown; sdp?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "Malformed session request" }, { status: 400 }); }
  const milestoneId = typeof body.milestoneId === "string" ? body.milestoneId : "";
  const sdp = typeof body.sdp === "string" ? body.sdp : "";
  if (!/^[0-9a-f-]{36}$/i.test(milestoneId) || !sdp.startsWith("v=0\r\n") || sdp.length > 100_000) {
    return NextResponse.json({ error: "Invalid milestone or WebRTC offer" }, { status: 400 });
  }

  // Ownership + card content. summary_doc is the on-screen guiding document the
  // coach anchors to; title/summary/learning_points are the fallback when a
  // summary hasn't been generated yet.
  const { data: milestone } = await supabase
    .from("milestones")
    .select("id, title, summary, summary_doc, learning_points, kanban_column, tracks!track_id!inner(user_id)")
    .eq("id", milestoneId)
    .single();

  if (!milestone) {
    return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
  }

  const title      = (milestone as { title: string }).title;
  const summaryDoc = ((milestone as { summary_doc?: string | null }).summary_doc ?? "").trim();

  // Fallback context (only used when no summary_doc exists yet): the card's own
  // criteria block plus capped diary notes, so the coach still has something to
  // anchor the reflection to.
  let fallbackContext: string | undefined;
  if (!summaryDoc) {
    const { data: entries } = await supabase
      .from("milestone_entries")
      .select("title, body")
      .eq("milestone_id", milestoneId)
      .order("created_at", { ascending: true });

    const criteria = buildCriteria({
      title,
      summary:        (milestone as { summary?: string | null }).summary ?? null,
      learningPoints: ((milestone as { learning_points?: LearningPoint[] | null }).learning_points) ?? null,
    });
    const diaryContext = prepareDiaryContext(entries ?? [], MAX_DIARY_CHARS);
    fallbackContext = diaryContext
      ? `${renderCriteriaForPrompt(criteria)}\n\n${diaryContext}`
      : renderCriteriaForPrompt(criteria);
  }

  const instructions = buildGuidedCoachInstructions({
    topicTitle:  title,
    summaryDoc:  summaryDoc || undefined,
    fallbackContext,
  });

  // create_response:true — the coach DRIVES an adaptive reflection. This is an
  // UNMARKED session (Phase 30): no scoring, no conclude tool. It simply guides
  // the learner through the on-screen summary until the learner ends the session.
  const sessionConfig = {
    type:  "realtime" as const,
    model: REALTIME_MODEL,
    max_output_tokens: MAX_RESPONSE_OUTPUT_TOKENS,
    truncation: {
      type: "retention_ratio" as const,
      retention_ratio: 0.8,
      token_limits: { post_instructions: MAX_CONTEXT_TOKENS },
    },
    instructions,
    audio: {
      input: {
        transcription:  { model: REALTIME_TRANSCRIPTION_MODEL, language: TRANSCRIPTION_LANGUAGE },
        turn_detection: TURN_DETECTION,
      },
      output: { voice: MASTERY_VOICE },
    },
  };

  const { data: reserved, error: reserveError } = await db.rpc("start_mastery_realtime_session", {
    p_user_id: userId, p_milestone_id: milestoneId, p_seconds: MAX_SESSION_SECONDS,
    p_reserve_usd: SESSION_RESERVE_USD, p_user_budget_usd: SESSION_USER_BUDGET_USD,
    p_workspace_budget_usd: SESSION_WORKSPACE_BUDGET_USD,
    p_user_concurrency: SESSION_USER_CONCURRENCY,
    p_workspace_concurrency: SESSION_WORKSPACE_CONCURRENCY,
  });
  if (reserveError || typeof reserved !== "string") {
    const limited = /realtime_(budget|concurrency)_limit/.test(reserveError?.message ?? "");
    if (!limited) console.error("[mastery/realtime-session] reservation failed:", reserveError?.message);
    return NextResponse.json({ error: limited ? "Live voice allowance or active-session limit reached." : "Realtime admission is unavailable." }, { status: limited ? 429 : 503 });
  }
  const sessionId = reserved;
  let callId: string | null = null;
  try {
    const form = new FormData();
    form.set("sdp", sdp);
    form.set("session", JSON.stringify(sessionConfig));
    const res = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "X-Client-Request-Id": sessionId },
      body: form, signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Provider call creation failed (${res.status})`);
    callId = callIdFromLocation(res.headers.get("location"));
    if (!callId) throw new Error("Provider call ID missing");
    // Persist the call ID as early as possible. A process lost during the
    // sideband handshake still leaves a call the minute worker can hang up.
    const { error: bindError } = await db.from("mastery_realtime_sessions")
      .update({ provider_call_id: callId }).eq("id", sessionId).eq("state", "starting");
    if (bindError) throw new Error("Provider call binding failed");
    const answerSdp = await res.text();
    const socket = await attachSideband(callId);
    const { data: active, error: activateError } = await db.from("mastery_realtime_sessions")
      .update({ provider_call_id: callId, state: "active" }).eq("id", sessionId)
      .eq("state", "starting").select("deadline_at").single();
    if (activateError || !active?.deadline_at || socket.readyState !== 1) {
      socket.terminate();
      throw new Error("Session activation failed");
    }
    // Attach event listeners before returning the SDP answer; after() retains
    // the already-running observer for the full call lifetime.
    const observer = monitorCall(socket, sessionId, callId, userId, Date.parse(active.deadline_at), usagePeriodStart);
    after(() => observer);
    return NextResponse.json({
      sessionId,
      answerSdp,
      model:                 REALTIME_MODEL,
      voice:                 MASTERY_VOICE,
      transcriptionModel:    REALTIME_TRANSCRIPTION_MODEL,
      transcriptionLanguage: TRANSCRIPTION_LANGUAGE,
      turnDetection:         TURN_DETECTION,
      maxSessionSeconds:     MAX_SESSION_SECONDS,
      maxFollowups:          MAX_FOLLOWUPS,
      inactivityMs:          INACTIVITY_MS,
    });
  } catch (err) {
    console.error("[mastery/realtime-session] error:", err);
    const hungUp = callId ? await hangupCall(callId) : true;
    const { error: finalError } = await db.from("mastery_realtime_sessions").update(hungUp
      ? { state: "failed", end_reason: "startup_error", ended_at: new Date().toISOString() }
      : { state: "starting", provider_call_id: callId, end_reason: "startup_hangup_retry", deadline_at: new Date().toISOString() }
    ).eq("id", sessionId);
    if (finalError) console.error("[mastery/realtime-session] startup recovery record failed:", finalError.message);
    return NextResponse.json({ error: "Failed to start realtime session." }, { status: 502 });
  }
}
