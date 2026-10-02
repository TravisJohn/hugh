// ── Realtime mastery usage accounting (pure, no I/O) ────────────────────────
//
// The server sideband now uses these pure accumulators for provider usage
// events. The browser also keeps local totals for its transcript UI, but they
// do not authorize or bill a new call. `boundTotals` remains solely for the
// temporary legacy reporting drain from pre-migration ephemeral sessions.
//
// Two events carry usage, and they are NOT the same source:
//   • `response.done` -> `response.usage`, the coach model's own tokens.
//   • `conversation.item.input_audio_transcription.completed` -> `usage`, the
//     transcription model. This is NOT included in `response.usage`.
// Two models, two rates, and so at least two rows. See `lib/pricing.ts`.
//
// What this is NOT: an invoice. It records what the API reported. Providers
// have been observed to return totals that do not reconcile exactly with the
// billing meter, and the detail breakdown is sometimes omitted entirely (see
// `split` below). Treat these rows as Hugh's best honest record of a spend it
// cannot directly observe, not as the bill.

/** Tokens for one session, split by the rate class that prices them. */
export interface RealtimeUsageTotals {
  /** Coach model, audio tokens — the expensive class (10.00 / 20.00). */
  audioIn:  number;
  audioOut: number;
  /** Coach model, text tokens (0.60 / 2.40). */
  textIn:   number;
  textOut:  number;
  /** Transcription model; audio and text input price the same, so no split. */
  transcriptionIn:  number;
  transcriptionOut: number;
}

/** One `usage_logs` row: a model, and the tokens priced at that model's rate. */
export interface RealtimeUsageRow {
  model:     string;
  tokensIn:  number;
  tokensOut: number;
}

/**
 * A deliberately LOOSE ceiling on tokens per second of session, per bucket.
 *
 * This is a tamper guard, not an estimate. Realtime audio runs on the order of
 * 17 tokens/second; this allows roughly triple that, so a legitimate session is
 * never clipped, while a browser claiming millions of tokens for a 15-minute
 * call still gets cut down to something physically possible.
 */
export const MAX_TOKENS_PER_SECOND = 50;

export function emptyTotals(): RealtimeUsageTotals {
  return {
    audioIn: 0, audioOut: 0,
    textIn:  0, textOut:  0,
    transcriptionIn: 0, transcriptionOut: 0,
  };
}

/**
 * Coerce an untrusted value to a usable token count.
 *
 * Everything here arrives from the browser, so undefined, null, strings, NaN,
 * Infinity and negatives are all reachable. A bad value contributes zero rather
 * than poisoning the whole session's total with NaN.
 */
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** The token-detail shape, as much of it as we depend on. */
interface TokenDetails {
  text_tokens?:  unknown;
  audio_tokens?: unknown;
}

/**
 * Split one direction's tokens between the audio and text rate classes.
 *
 * When the detail breakdown is present we use it. When it is absent — which
 * happens; the API does not always send it — we know the total but not the mix,
 * and we attribute ALL of it to audio.
 *
 * That is on purpose, and it is the same doctrine as `FALLBACK_MODEL` in
 * `lib/pricing.ts`: audio is the expensive class, so attributing an unknown mix
 * there over-states spend. An unknown must never be able to hide spend, and in
 * a voice session audio is the honest guess anyway.
 */
function split(total: number, details: TokenDetails | undefined): { audio: number; text: number } {
  const audio = count(details?.audio_tokens);
  const text  = count(details?.text_tokens);

  // No usable breakdown: attribute the lot to audio.
  if (audio === 0 && text === 0) return { audio: total, text: 0 };

  // A breakdown that undershoots the reported total leaves a remainder that is
  // real spend of unknown class — same rule, it goes to audio.
  const remainder = Math.max(0, total - audio - text);
  return { audio: audio + remainder, text };
}

interface ResponseUsage {
  input_tokens?:         unknown;
  output_tokens?:        unknown;
  input_token_details?:  TokenDetails;
  output_token_details?: TokenDetails;
}

/**
 * Fold one `response.done` event's usage into the running totals.
 *
 * Returns a new object; the caller keeps no mutable shared state. An event with
 * no usage at all is a no-op rather than an error — not every response carries
 * one, and a missing figure must not break the conversation.
 */
export function accumulateResponse(
  totals: RealtimeUsageTotals,
  usage:  ResponseUsage | undefined | null,
): RealtimeUsageTotals {
  if (!usage || typeof usage !== "object") return totals;

  const inTotal  = count(usage.input_tokens);
  const outTotal = count(usage.output_tokens);
  if (inTotal === 0 && outTotal === 0) return totals;

  const inSplit  = split(inTotal,  usage.input_token_details);
  const outSplit = split(outTotal, usage.output_token_details);

  return {
    ...totals,
    audioIn:  totals.audioIn  + inSplit.audio,
    audioOut: totals.audioOut + outSplit.audio,
    textIn:   totals.textIn   + inSplit.text,
    textOut:  totals.textOut  + outSplit.text,
  };
}

interface TranscriptionUsage {
  type?:          unknown;
  input_tokens?:  unknown;
  output_tokens?: unknown;
}

/**
 * Fold one transcription event's usage into the running totals.
 *
 * No audio/text split: `gpt-4o-mini-transcribe` prices audio and text input
 * identically (1.25), so splitting them would add a distinction that changes no
 * number.
 *
 * The API can report this as `{ type: "duration", seconds }` instead of tokens.
 * There is no honest token conversion for that, so it contributes nothing
 * rather than a fabricated figure — a known, documented gap, not a silent one.
 */
export function accumulateTranscription(
  totals: RealtimeUsageTotals,
  usage:  TranscriptionUsage | undefined | null,
): RealtimeUsageTotals {
  if (!usage || typeof usage !== "object") return totals;
  if (usage.type === "duration") return totals;

  return {
    ...totals,
    transcriptionIn:  totals.transcriptionIn  + count(usage.input_tokens),
    transcriptionOut: totals.transcriptionOut + count(usage.output_tokens),
  };
}

/**
 * Clamp reported totals to what a session of this length could physically emit.
 *
 * The browser reports these figures, so they are bounded rather than trusted.
 * The ceiling is per bucket and deliberately generous
 * (`MAX_TOKENS_PER_SECOND`) — its job is to make a fabricated number
 * impossible, not to second-guess a real one.
 *
 * `maxSessionSeconds` comes from the server's own `realtimeConfig`, never from
 * the request, or the bound would be as forgeable as the thing it bounds.
 */
export function boundTotals(
  totals:            RealtimeUsageTotals,
  maxSessionSeconds: number,
): { bounded: RealtimeUsageTotals; clamped: boolean } {
  const ceiling = count(maxSessionSeconds) * MAX_TOKENS_PER_SECOND;

  let clamped = false;
  const cap = (n: number): number => {
    const safe = count(n);
    if (safe > ceiling) { clamped = true; return ceiling; }
    return safe;
  };

  return {
    bounded: {
      audioIn:  cap(totals.audioIn),
      audioOut: cap(totals.audioOut),
      textIn:   cap(totals.textIn),
      textOut:  cap(totals.textOut),
      transcriptionIn:  cap(totals.transcriptionIn),
      transcriptionOut: cap(totals.transcriptionOut),
    },
    clamped,
  };
}

/**
 * Turn totals into the rows to log — one per rate class, at that class's rate.
 *
 * Rows with no tokens are dropped: `logUsage` ignores an all-zero call anyway,
 * and an empty row in `usage_logs` would show up in the admin views as a spend
 * event that never happened.
 */
export function toUsageRows(totals: RealtimeUsageTotals): RealtimeUsageRow[] {
  const rows: RealtimeUsageRow[] = [
    { model: "gpt-realtime-mini",      tokensIn: totals.audioIn,         tokensOut: totals.audioOut         },
    { model: "gpt-realtime-mini-text", tokensIn: totals.textIn,          tokensOut: totals.textOut          },
    { model: "gpt-4o-mini-transcribe", tokensIn: totals.transcriptionIn, tokensOut: totals.transcriptionOut },
  ];
  return rows.filter((r) => r.tokensIn > 0 || r.tokensOut > 0);
}

/** True when a session reported nothing at all — worth distinguishing in logs. */
export function isEmpty(totals: RealtimeUsageTotals): boolean {
  return toUsageRows(totals).length === 0;
}
