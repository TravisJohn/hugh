import "server-only";

// ── Realtime mastery configuration (single source of truth, server-only) ────
// Imported by the ephemeral-session route to build the coach session. The
// browser receives model names, a minted credential and client-side caps.
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
// an ElevenLabs-era concern; the mastery coach is one consistent voice.)
export const MASTERY_VOICE = "cedar";

// ── Client-side backstops (not security-enforced caps; audit S3) ─────────────
// Phase 30 (Guided Reflection) is UNMARKED and learner-ended — the coach never
// concludes on its own. These values guide the normal browser's behavior. A
// modified client can ignore them; server-owned limits are still required
// before enabling Realtime for regular learners.
export const MAX_SESSION_SECONDS = 15 * 60;  // normal browser's session deadline
export const MAX_FOLLOWUPS       = 24;       // coach turns before the backstop trips
export const INACTIVITY_MS       = 120_000;  // silence window before auto-ending

// Diary context is supporting learner colour only — capped so it can never
// dominate the authoritative card criteria in the prompt.
export const MAX_DIARY_CHARS = 2_500;
