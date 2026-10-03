import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { enforceUsageGate } from "@/lib/usage";
import { canUseRealtime } from "@/lib/mastery/realtimeAccess";
import { logSafeError } from "@/lib/observability/log";
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
  MAX_FOLLOWUPS,
  INACTIVITY_MS,
  MAX_DIARY_CHARS,
} from "@/lib/mastery/realtimeConfig";

export const dynamic = "force-dynamic";

// Mints a short-lived ephemeral credential for a Realtime MASTERY coach session.
// The browser receives a limited credential, never OPENAI_API_KEY. Session
// instructions and settings must not be treated as secrets from that client.
// S3 containment: flag-, authenticated-admin-, and usage-gated.

const CLIENT_SECRET_TTL_SECONDS = 600;

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
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("is_admin, is_blocked")
      .eq("user_id", userId)
      .single();
    if (error) {
      logSafeError("mastery/realtime-session access", error);
      return NextResponse.json({ error: "Realtime access checks are temporarily unavailable. Try again shortly." }, { status: 503 });
    }
    if (!canUseRealtime(process.env.MASTERY_REALTIME_ENABLED, profile)) {
      return NextResponse.json({ error: "Realtime voice is currently an administrator preview." }, { status: 403 });
    }
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

  const body = (await request.json()) as { milestoneId?: string };
  const milestoneId = body.milestoneId;
  if (!milestoneId) {
    return NextResponse.json({ error: "milestoneId is required" }, { status: 400 });
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
    instructions,
    audio: {
      input: {
        transcription:  { model: REALTIME_TRANSCRIPTION_MODEL, language: TRANSCRIPTION_LANGUAGE },
        turn_detection: TURN_DETECTION,
      },
      output: { voice: MASTERY_VOICE },
    },
  };

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: CLIENT_SECRET_TTL_SECONDS },
        session: sessionConfig,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("[mastery/realtime-session] mint failed:", res.status, detail);
      return NextResponse.json({ error: "Failed to start realtime session." }, { status: 502 });
    }

    const data = (await res.json()) as { value?: string; expires_at?: number };
    if (!data.value) {
      console.error("[mastery/realtime-session] mint response missing client secret");
      return NextResponse.json({ error: "Failed to start realtime session." }, { status: 502 });
    }

    return NextResponse.json({
      clientSecret:          data.value,
      expiresAt:             data.expires_at ?? null,
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
    return NextResponse.json({ error: "Failed to start realtime session." }, { status: 502 });
  }
}
