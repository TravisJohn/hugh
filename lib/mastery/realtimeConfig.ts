import "server-only";

// ── Realtime mastery configuration (single source of truth, server-only) ────
// Imported by the server-owned call route to build the coach session.
// OPENAI_API_KEY stays server-side. Realtime is an admin preview (audit S3).

// Speech-to-speech model that CONDUCTS the mastery conversation.
export const REALTIME_MODEL = "gpt-realtime-mini";

// Explicit transcription model for the learner's speech (never a default) so the
// transcript that feeds the recap is deterministic. Transcription still runs, but
// it is NOT shown live (distracting + it guessed wrong languages) — it's captured
// silently for the end-of-session recap only. Mini tier: this text never drives
// the live conversation (the coach hears raw audio directly), it only feeds the
// end-of-session Haiku recap — so mini's lower accuracy risks a slightly rougher
// recap, not a worse conversation.
export const REALTIME_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

// Pin the transcription language so it stops guessing (and mis-rendering) other
// languages mid-conversation. One-line change if the app ever goes multilingual.
export const TRANSCRIPTION_LANGUAGE = "en";

// ── Turn detection (noise robustness) ───────────────────────────────────────
// server_vad tuned to be LESS jumpy than the defaults, because the reflection is
// held in ordinary rooms with background noise:
//   • threshold 0.75 (default 0.5) — needs clear, deliberate speech to trigger,
//     so ambient noise doesn't register as the learner talking. This high
//     threshold is what keeps barge-in from firing on stray sounds.
//   • silence_duration_ms 900 (default ~500) — waits ~0.9 s of silence before
//     ending a turn, so a thinking pause isn't cut off (fixes "I feel rushed").
//   • interrupt_response true — the learner CAN talk over the coach and it stops
//     to listen (the natural, conversational feel). The high threshold is the
//     guard that stops background noise from doing this accidentally.
export const TURN_DETECTION = {
  type:                "server_vad" as const,
  threshold:           0.75,
  prefix_padding_ms:   300,
  silence_duration_ms: 900,
  create_response:     true,
  interrupt_response:  true,
};

// A single calm, coach-like built-in Realtime voice. (Persona randomisation was
// a retired persona concern; the mastery coach is one consistent voice.)
export const MASTERY_VOICE = "cedar";

// Short preview sessions fit inside a server function's configured lifetime.
// The server observer enforces these; browser timers are only a UI backstop.
export const MAX_SESSION_SECONDS = 120;
export const MAX_FOLLOWUPS       = 12;
export const INACTIVITY_MS       = 60_000;
export const MAX_RESPONSE_OUTPUT_TOKENS = 500;
export const MAX_CONTEXT_TOKENS = 2_000;

// Diary context is supporting learner colour only — capped so it can never
// dominate the authoritative card criteria in the prompt.
export const MAX_DIARY_CHARS = 2_500;
