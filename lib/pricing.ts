/**
 * Per-model token pricing.
 *
 * `usage_logs` records the model that served each call (migration 036), so cost
 * is computed per log row and summed — never by applying one blended rate to an
 * aggregate. Hugh mixes Sonnet, Haiku and several OpenAI models whose rates
 * differ by up to 67x — gpt-4o-mini text input at 0.15 against realtime audio
 * input at 10.00 — so aggregate-then-price overstates the cheap routes badly.
 *
 * Pure and dependency-free so it can be unit-tested without Supabase.
 */

/** USD per 1,000,000 tokens. */
export interface ModelRate {
  input:  number;
  output: number;
}

export const MODEL_RATES: Record<string, ModelRate> = {
  // Anthropic — see CLAUDE.md "Model Selection"
  "claude-sonnet-4-6":      { input: 3,    output: 15   },
  "claude-haiku-4-5":       { input: 1,    output: 5    },
  // The same models served by the owner's own Claude plan in local
  // subscription mode (lib/claude/billingMode.ts). Rate classes like
  // `gpt-realtime-mini-text` below: they appear only in `usage_logs.model`,
  // never in a request. Token counts stay real; the money is $0.
  "claude-sonnet-4-6@subscription": { input: 0, output: 0 },
  "claude-haiku-4-5@subscription":  { input: 0, output: 0 },
  // OpenAI — Notes Coach (vision), Notes summariser, architecture assistant
  "gpt-4o":                 { input: 2.5,  output: 10   },
  "gpt-4o-mini":            { input: 0.15, output: 0.6  },

  // OpenAI Realtime — mastery voice coach (`MASTERY_REALTIME_ENABLED`).
  //
  // Realtime bills audio and text tokens at DIFFERENT rates on the same model:
  // audio input is 10.00 against text's 0.60, a 16x spread. `ModelRate` holds one
  // input/output pair, so the two rate classes are registered as two keys and the
  // accumulator splits a session's tokens between them. `gpt-realtime-mini-text`
  // is therefore a RATE CLASS, not an OpenAI model id — it will never appear in a
  // request, only in a `usage_logs.model` column. Blending them into one key
  // would restate a voice session's cost by up to 16x, which is exactly what the
  // per-row rule at the top of this file exists to prevent.
  "gpt-realtime-mini":      { input: 10,   output: 20   },  // audio tokens
  "gpt-realtime-mini-text": { input: 0.6,  output: 2.4  },  // text tokens
  // Transcription of the learner's speech. Audio and text input are both 1.25,
  // so this one genuinely needs no split.
  "gpt-4o-mini-transcribe": { input: 1.25, output: 5    },
};

/**
 * Used when a log row has no model (rows written before migration 036) or an
 * unrecognised one. Deliberately the most expensive Claude rate: an unknown
 * model should over-estimate rather than hide spend.
 */
export const FALLBACK_MODEL = "claude-sonnet-4-6";

/** ElevenLabs, USD per character (~Creator plan). */
export const COST_PER_TTS_CHAR = 0.30 / 1_000;

export function isKnownModel(model: string | null | undefined): boolean {
  return Boolean(model && model in MODEL_RATES);
}

export function rateFor(model: string | null | undefined): ModelRate {
  if (model && model in MODEL_RATES) return MODEL_RATES[model];
  return MODEL_RATES[FALLBACK_MODEL];
}

/**
 * Cost of a single logged call. `model` is optional so TTS-only rows (which
 * have no model) and pre-036 rows still price sensibly.
 */
export function estimateCost(
  tokensIn:  number,
  tokensOut: number,
  ttsChars:  number,
  model?:    string | null,
): number {
  const rate = rateFor(model);
  return (tokensIn  * rate.input  / 1_000_000)
       + (tokensOut * rate.output / 1_000_000)
       + (ttsChars  * COST_PER_TTS_CHAR);
}

/** One row of `usage_logs`, as far as pricing is concerned. */
export interface PricedUsageRow {
  tokens_in?:  number | null;
  tokens_out?: number | null;
  tts_chars?:  number | null;
  model?:      string | null;
}

/**
 * Sum cost across many log rows, pricing each at its own model's rate.
 * This is the only correct way to total a mixed-model period.
 */
export function totalCost(rows: readonly PricedUsageRow[]): number {
  return rows.reduce(
    (sum, r) => sum + estimateCost(r.tokens_in ?? 0, r.tokens_out ?? 0, r.tts_chars ?? 0, r.model),
    0,
  );
}
