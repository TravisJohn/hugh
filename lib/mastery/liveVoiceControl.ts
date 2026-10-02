import "server-only";
import WebSocket from "ws";
import { createServiceClient } from "@/lib/supabase/service";
import { estimateCost } from "@/lib/pricing";
import { accumulateResponse, accumulateTranscription, emptyTotals, toUsageRows } from "./realtimeUsage";
import { MAX_FOLLOWUPS, INACTIVITY_MS, MAX_RESPONSE_OUTPUT_TOKENS } from "./realtimeConfig";

const API = "https://api.openai.com/v1/realtime/calls";
export const SESSION_RESERVE_USD = 0.20;
export const SESSION_USER_BUDGET_USD = 2;
export const SESSION_WORKSPACE_BUDGET_USD = 10;
export const SESSION_USER_CONCURRENCY = 1;
export const SESSION_WORKSPACE_CONCURRENCY = 2;

export function callIdFromLocation(location: string | null): string | null {
  const match = location?.match(/^\/v1\/realtime\/calls\/(rtc_[A-Za-z0-9_-]+)$/);
  return match?.[1] ?? null;
}

export async function hangupCall(callId: string): Promise<boolean> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !/^rtc_[A-Za-z0-9_-]+$/.test(callId)) return false;
  try {
    const response = await fetch(`${API}/${callId}/hangup`, {
      method: "POST", headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    return response.ok || response.status === 404;
  } catch (error) {
    console.error("[mastery/realtime] hangup failed:", error);
    return false;
  }
}

export async function endCall(sessionId: string, callId: string, reason: string): Promise<boolean> {
  if (!(await hangupCall(callId))) return false;
  const db = createServiceClient();
  const { error } = await db.from("mastery_realtime_sessions")
    .update({ state: "ended", end_reason: reason, ended_at: new Date().toISOString() })
    .eq("id", sessionId).in("state", ["starting", "active"]);
  if (error) {
    console.error("[mastery/realtime] session end update failed:", error.message);
    return false;
  }
  return true;
}

export async function attachSideband(callId: string): Promise<WebSocket> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Realtime key unavailable");
  const socket = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  // Retain an error listener across the short gap between open and monitor
  // registration; an unhandled EventEmitter error would crash this invocation.
  socket.on("error", error => console.error("[mastery/realtime] sideband socket error:", error));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Sideband connection timed out")); }, 8000);
    const onError = (error: Error) => { clearTimeout(timeout); reject(error); };
    socket.once("open", () => { clearTimeout(timeout); socket.off("error", onError); resolve(); });
    socket.once("error", onError);
  });
  return socket;
}

interface ProviderEvent {
  type?: string;
  event_id?: string;
  item_id?: string;
  response?: { id?: string; max_output_tokens?: number | "inf"; usage?: Parameters<typeof accumulateResponse>[1] };
  usage?: Parameters<typeof accumulateTranscription>[1];
}

export function eventUsage(event: ProviderEvent) {
  if (event.type === "response.done") {
    const key = event.response?.id ?? event.event_id;
    return key ? { key: `response:${key}`, totals: accumulateResponse(emptyTotals(), event.response?.usage) } : null;
  }
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    const key = event.item_id ?? event.event_id;
    return key ? { key: `transcription:${key}`, totals: accumulateTranscription(emptyTotals(), event.usage) } : null;
  }
  return null;
}

export function usageCost(totals: ReturnType<typeof emptyTotals>): number {
  return toUsageRows(totals).reduce((sum, row) =>
    sum + estimateCost(row.tokensIn, row.tokensOut, 0, row.model), 0);
}

export async function recordSidebandUsage(sessionId: string, userId: string, event: ProviderEvent, usagePeriodStart: string): Promise<number | null> {
  const measured = eventUsage(event);
  if (!measured) return null;
  const t = measured.totals;
  const db = createServiceClient();
  const { data, error } = await db.rpc("record_mastery_realtime_event", {
    p_session_id: sessionId, p_event_key: measured.key,
    p_audio_in: t.audioIn, p_audio_out: t.audioOut,
    p_text_in: t.textIn, p_text_out: t.textOut,
    p_transcription_in: t.transcriptionIn, p_transcription_out: t.transcriptionOut,
    p_cost_usd: usageCost(t), p_period_start: usagePeriodStart,
  });
  if (error) throw new Error(`Realtime accounting failed for ${userId}: ${error.message}`);
  const total = Number(data);
  if (!Number.isFinite(total)) throw new Error("Realtime accounting returned no cost total");
  return total;
}

/** Keeps the server function alive after the SDP response; errors end the call. */
export async function monitorCall(socket: WebSocket, sessionId: string, callId: string, userId: string, deadlineAt: number, usagePeriodStart: string): Promise<void> {
  let closed = false;
  let lastActivity = Date.now();
  let responses = 0;
  const seenResponses = new Set<string>();
  let pending = Promise.resolve();
  let stopReason: string | null = null;
  const stop = async (reason: string) => {
    if (closed) return;
    closed = true;
    clearInterval(ticker);
    socket.terminate();
    if (!(await endCall(sessionId, callId, reason))) {
      console.error(`[mastery/realtime] hangup requires recovery: ${sessionId}`);
    }
  };
  const ticker = setInterval(() => {
    if (Date.now() >= deadlineAt) stopReason = "max_duration";
    else if (Date.now() - lastActivity >= INACTIVITY_MS) stopReason = "inactivity";
    if (stopReason) pending = pending.then(() => stop(stopReason!));
  }, 1000);

  await new Promise<void>(resolve => {
    socket.on("message", raw => {
      if (closed) return;
      pending = pending.then(async () => {
        const event = JSON.parse(raw.toString()) as ProviderEvent;
        // Hugh's browser sends no session.update. Any update is an attempt to
        // change the server's model, instructions, turn policy or cost limits.
        if (event.type === "session.updated") {
          stopReason = "session_limit_modified";
        }
        if (event.type === "response.created" && event.response?.max_output_tokens !== undefined &&
            (event.response.max_output_tokens === "inf" || event.response.max_output_tokens > MAX_RESPONSE_OUTPUT_TOKENS)) {
          stopReason = "response_limit_modified";
        }
        if (["input_audio_buffer.speech_started", "response.created", "response.done"].includes(event.type ?? "")) {
          lastActivity = Date.now();
        }
        if (event.type === "response.done") {
          const id = event.response?.id;
          if (!id) throw new Error("Response missing id");
          if (!seenResponses.has(id)) { seenResponses.add(id); responses += 1; }
        }
        if (event.type === "response.done" || event.type === "conversation.item.input_audio_transcription.completed") {
          if (!eventUsage(event)) throw new Error("Usage event missing stable identifier");
          const cost = await recordSidebandUsage(sessionId, userId, event, usagePeriodStart);
          if (cost !== null && cost >= SESSION_RESERVE_USD) stopReason = "session_budget";
        }
        if (responses > MAX_FOLLOWUPS) stopReason = "max_followups";
        if (stopReason) await stop(stopReason);
      }).catch(async error => {
        console.error("[mastery/realtime] observer failed:", error);
        await stop("observer_error");
      });
    });
    socket.once("close", () => {
      clearInterval(ticker);
      pending.finally(async () => { if (!closed) await endCall(sessionId, callId, "sideband_closed"); resolve(); });
    });
    socket.once("error", error => {
      console.error("[mastery/realtime] sideband socket error:", error);
      pending = pending.then(() => stop("observer_error"));
    });
  });
}
