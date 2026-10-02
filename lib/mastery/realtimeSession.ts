// ── Realtime mastery transport (browser, framework-agnostic) ────────────────
// Owns one WebRTC session for the mastery coach: mic capture, remote audio,
// the `oai-events` data channel, and the events the mastery flow needs. The
// coach DRIVES the conversation (create_response:true); this transport only
// observes — it never scores or persists.
//
// Guarantees:
//   • conclude_assessment is idempotent — only the FIRST valid call fires
//     onConclude; a fabricated "score" in the tool args is ignored (the coach
//     cannot inject a result).
//   • Events after dispose() can never fire callbacks (disposed guard).
//   • Transcript turns are deduped by id and finalised in arrival order.
//   • Browser usage totals are diagnostic. Server sideband events own billing.
//
// The event handler `ingestEvent` is deliberately callable in isolation so the
// idempotency / dedup logic can be unit-tested without a live connection.

import type {
  MasteryRealtimeStatus,
  MasteryRealtimeError,
  MasteryRealtimeCredentials,
  MasteryTranscriptTurn,
} from "@/types";
import {
  emptyTotals,
  accumulateResponse,
  accumulateTranscription,
  type RealtimeUsageTotals,
} from "./realtimeUsage";

export interface MasteryRealtimeCallbacks {
  onStatus:     (status: MasteryRealtimeStatus) => void;
  onError:      (error: MasteryRealtimeError) => void;
  onTranscript: (turns: MasteryTranscriptTurn[]) => void;
  onCoachTurn:  () => void;              // a coach spoken turn completed
  onConclude:   (reason: string) => void; // fired at most once
}

interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof RTCPeerConnection !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export class MasteryRealtimeSession {
  private pc:        RTCPeerConnection | null = null;
  private dc:        RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private audioEl:   HTMLAudioElement | null = null;

  private disposed = false;
  private concludedOnce = false;
  private status: MasteryRealtimeStatus = "idle";

  private firstAudioForResponse = false;

  // Ordered transcript with id-based dedup.
  private turns: MasteryTranscriptTurn[] = [];
  private seenKeys = new Set<string>();

  private sessionId: string | null = null;

  // Running token totals for this session, folded from the events below. Kept
  // here rather than in the hook so a re-render cannot lose a figure that no
  // other system holds.
  private usage: RealtimeUsageTotals = emptyTotals();

  constructor(private readonly cb: MasteryRealtimeCallbacks) {}

  getStatus(): MasteryRealtimeStatus { return this.status; }
  getTranscript(): MasteryTranscriptTurn[] { return [...this.turns]; }
  getSessionId(): string | null { return this.sessionId; }

  /**
   * Token totals observed so far.
   *
   * Deliberately still readable AFTER dispose(): every path that ends a session
   * tears the connection down first, and the spend has to survive that or it is
   * never recorded at all.
   */
  getUsage(): RealtimeUsageTotals { return { ...this.usage }; }

  private setStatus(next: MasteryRealtimeStatus): void {
    if (this.disposed) return;
    this.status = next;
    this.cb.onStatus(next);
  }

  private fail(kind: MasteryRealtimeError["kind"], message: string): void {
    if (this.disposed) return;
    this.status = "error";
    this.cb.onStatus("error");
    this.cb.onError({ kind, message });
  }

  // ── Connection ────────────────────────────────────────────────────────────
  async connect(milestoneId: string): Promise<MasteryRealtimeCredentials | null> {
    if (this.disposed) return null;
    if (!isSupported()) {
      this.fail("unsupported", "This browser does not support the realtime voice connection.");
      return null;
    }
    this.setStatus("connecting");

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      this.fail("mic_permission", "Microphone access is required for the mastery session.");
      return null;
    }
    if (this.disposed) return null;

    try {
      const pc = new RTCPeerConnection();
      this.pc = pc;

      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      this.audioEl = audioEl;

      pc.ontrack = (e) => {
        if (this.disposed) return;
        if (this.audioEl) this.audioEl.srcObject = e.streams[0];
      };

      const micTrack = this.micStream.getAudioTracks()[0];
      if (micTrack) pc.addTrack(micTrack, this.micStream);

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (ev) => {
        if (this.disposed) return;
        try { this.ingestEvent(JSON.parse(ev.data as string) as ServerEvent); }
        catch { /* ignore non-JSON */ }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.disposed) return null;

      const sdpRes = await fetch('/api/tracker/mastery/realtime-session', {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ milestoneId, sdp: offer.sdp }),
      });
      if (!sdpRes.ok) {
        const body = await sdpRes.json().catch(() => ({})) as { error?: string };
        this.fail("connection", body.error ?? `Realtime handshake failed (${sdpRes.status}).`);
        return null;
      }
      const creds = await sdpRes.json() as MasteryRealtimeCredentials;
      this.sessionId = creds.sessionId;
      if (this.disposed) {
        void fetch('/api/tracker/mastery/realtime-end', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: creds.sessionId, reason: 'disconnected' }), keepalive: true,
        }).catch(() => {});
        return null;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: creds.answerSdp });
      if (this.disposed) return null;

      this.setStatus("listening"); // connected; coach will open shortly
      return creds;
    } catch (err) {
      console.error("[mastery-realtime] connect error:", err);
      this.fail("connection", "Could not establish the realtime voice connection.");
      return null;
    }
  }

  private recordTurn(role: "coach" | "learner", key: string, text: string): void {
    const clean = text.trim();
    if (!clean || this.seenKeys.has(key)) return;
    this.seenKeys.add(key);
    this.turns.push({ role, text: clean });
    this.cb.onTranscript(this.getTranscript());
  }

  // ── Core event handler (testable in isolation) ──────────────────────────────
  ingestEvent(msg: ServerEvent): void {
    if (this.disposed) return;

    switch (msg.type) {
      case "input_audio_buffer.speech_started":
        this.setStatus("listening");
        break;

      case "response.created":
        this.firstAudioForResponse = false;
        this.setStatus("thinking");
        break;

      case "response.output_audio.delta":
        if (!this.firstAudioForResponse) {
          this.firstAudioForResponse = true;
          this.setStatus("coach_speaking");
        }
        break;

      // Learner's finalised speech for one item.
      case "conversation.item.input_audio_transcription.completed": {
        const key  = typeof msg.item_id === "string" ? msg.item_id : `learner-${this.turns.length}`;
        const text = typeof msg.transcript === "string" ? msg.transcript : "";
        // The transcription model bills separately and is NOT included in
        // `response.usage` — this event is the only place it is reported.
        this.usage = accumulateTranscription(
          this.usage,
          msg.usage as Parameters<typeof accumulateTranscription>[1],
        );
        this.recordTurn("learner", key, text);
        break;
      }

      // Coach's finalised spoken turn.
      case "response.output_audio_transcript.done": {
        const key  = typeof msg.item_id === "string" ? msg.item_id
                   : (typeof msg.response_id === "string" ? msg.response_id : `coach-${this.turns.length}`);
        const text = typeof msg.transcript === "string" ? msg.transcript : "";
        if (text.trim()) {
          this.recordTurn("coach", key, text);
          this.cb.onCoachTurn();
        }
        break;
      }

      // The coach signalled it has enough evidence.
      case "response.output_item.done": {
        const item = msg.item as { type?: string; name?: string; arguments?: string } | undefined;
        if (item?.type === "function_call" && item.name === "conclude_assessment") {
          this.handleConclude(item.arguments);
        }
        break;
      }
      case "response.function_call_arguments.done": {
        // Fallback signal for the same tool call. Treat as a conclusion when it's
        // the conclude tool (or when the event omits a name). handleConclude is
        // idempotent, so a duplicate with response.output_item.done is harmless.
        if (msg.name === "conclude_assessment" || typeof msg.name === "undefined") {
          this.handleConclude(typeof msg.arguments === "string" ? msg.arguments : undefined);
        }
        break;
      }

      case "response.done": {
        // Fold usage BEFORE the status guard below: a response arriving after a
        // conclusion still cost money and still has to be recorded.
        const response = msg.response as { usage?: unknown } | undefined;
        this.usage = accumulateResponse(
          this.usage,
          response?.usage as Parameters<typeof accumulateResponse>[1],
        );
        if (!this.concludedOnce && this.status !== "error") this.setStatus("listening");
        break;
      }

      case "error":
        console.error("[mastery-realtime] server error:", JSON.stringify(msg.error ?? {}));
        break;

      default:
        break;
    }
  }

  // Idempotent: only the first valid conclusion is honoured. Any "score" the
  // model puts in the args is deliberately ignored — the app owns the result.
  private handleConclude(argsJson: string | undefined): void {
    if (this.disposed || this.concludedOnce) return;
    this.concludedOnce = true;

    let reason = "coach concluded";
    if (argsJson) {
      try {
        const parsed = JSON.parse(argsJson) as { reason?: unknown };
        if (typeof parsed.reason === "string" && parsed.reason.trim()) reason = parsed.reason.trim();
      } catch { /* keep default reason */ }
    }
    this.setStatus("concluding");
    this.cb.onConclude(reason);
  }

  // ── Teardown ────────────────────────────────────────────────────────────────
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    try { this.dc?.close(); } catch { /* ignore */ }
    this.dc = null;

    try {
      this.pc?.getSenders().forEach((s) => s.track?.stop());
      this.pc?.close();
    } catch { /* ignore */ }
    this.pc = null;

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;

    if (this.audioEl) {
      try { this.audioEl.srcObject = null; this.audioEl.remove(); } catch { /* ignore */ }
      this.audioEl = null;
    }

    this.status = "disconnected";
  }
}
