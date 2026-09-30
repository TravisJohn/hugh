import type { TextCall, TextCallGuard } from "@/lib/claude/textInput";
/**
 * The milestone-generation call, on its own.
 *
 * Split out of `generate.ts` for the same reason `lib/tracker/priority.ts`
 * documents at its own top: `generate.ts` imports `logUsage` and `logSafeError`,
 * both of which import `server-only`, and `server-only` throws the moment a
 * plain Node process touches it. So a `tsx` script cannot import anything from
 * `generate.ts` at all.
 *
 * That matters because of what the offline replay harness needs to be true:
 * a replay has to re-run a stored generation through the SAME code as a
 * learner's build. If the script carried its own copy of the prompt call, the
 * retry and the parse, the eval would slowly drift into measuring the copy
 * rather than the product — and the drift would be invisible, because both
 * halves would keep passing their own tests.
 *
 * This module therefore has no `server-only` import anywhere in its graph, and
 * must not gain one. Usage logging and error scrubbing stay in `generate.ts`,
 * which is the server-side caller and the right place for both.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  milestoneGenerationPrompt,
  parseMilestoneGeneration,
  type MilestoneGenerationResult,
} from "@/lib/claude/prompts";
import { milestonePromptId, type PromptId } from "@/lib/claude/promptIdentity";

/**
 * The Anthropic client, built on first use rather than at import.
 *
 * This is not a micro-optimisation, it is a correctness fix. Constructing the
 * client in the module body reads `ANTHROPIC_API_KEY` the instant the module is
 * imported — and ES imports are hoisted, so a script that calls a `.env.local`
 * loader between its import statements has already evaluated this file before
 * that loader runs. The key is then undefined, and the SDK's complaint arrives
 * much later, once per generation, as a bare "Error" with no hint that the
 * cause was configuration. Next injects the environment before anything is
 * imported, so the app never saw this; a `tsx` script does not, so it did.
 *
 * Reading the key at call time removes the ordering hazard for every caller
 * instead of asking each new one to remember it.
 */
let client: Anthropic | null = null;

function anthropicClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Model for track generation — see CLAUDE.md "Model Selection".
 *
 * Kept in one place so the API call and the usage log can never disagree about
 * billing. `generateMilestones` returns whichever model it actually called, so
 * that single binding survives being handed across a function boundary.
 */
export const MODEL = "claude-sonnet-4-6";

/**
 * Recorded on the provenance row as well as sent with the call. It shapes the
 * output — a long track can be truncated by this ceiling, which presents as a
 * parse error and burns the retry — so a change to it has to be visible in the
 * eval.
 */
export const MAX_TOKENS = 2048;

/** Tokens spent generating a track, so the caller can log them. */
export interface GenerationUsage {
  inputTokens:  number;
  outputTokens: number;
}

export interface MilestoneGenerationOutcome {
  parsed:   MilestoneGenerationResult;
  usage:    GenerationUsage;
  attempts: number;
  /** The model actually called — see the note on `MODEL`. */
  model:    string;
  /**
   * The template actually rendered, for the same reason `model` is returned.
   *
   * Three templates now live behind this one function — plain, context, and
   * document — and the caller writes a fingerprint onto a provenance row. If
   * the caller re-derived which one was used, it could disagree with what was
   * sent, and the row would describe a prompt that never existed. One binding,
   * carried across the boundary.
   */
  promptId: PromptId;
}

/**
 * One milestone-generation call, with the retry and parse around it.
 *
 * Retries once on a malformed/unparseable response — mirrors the retry pattern
 * already used for the refine/classify-topic/domain-gate calls. Token counts
 * accumulate across attempts: a discarded first attempt still costs money, so
 * it must still be billed to the user.
 *
 * `model` defaults to `MODEL`, which is what a learner's build always uses. It
 * is a parameter so the replay harness can re-run a stored generation against
 * a different model through this exact path.
 *
 * `answers` is the context arm (C2). It is likewise a parameter rather than a
 * read: the live build passes nothing, so live rows keep accumulating as the
 * control arm exactly as migration 048 planned, and only the replay harness
 * runs the treatment. Flipping the live path is a separate decision that
 * should follow the evidence this produces, not precede it.
 *
 * The model used is returned rather than left for the caller to restate. That
 * is the "one binding" rule of CLAUDE.md holding at a function boundary: the
 * caller records what was actually called, so the API call and the provenance
 * row cannot disagree about which model produced the output.
 */
export async function generateMilestones(
  topic:         string,
  documentText?: string,
  model:         string = MODEL,
  answers?:      readonly { question: string; answer: string }[],
  beforeCall?:   TextCallGuard,
): Promise<MilestoneGenerationOutcome> {
  let lastErr: unknown = null;
  const usage: GenerationUsage = { inputTokens: 0, outputTokens: 0 };

  // Built once, outside the retry: both attempts must send the same prompt, and
  // the id recorded must be the id of the text that was actually sent.
  const content  = milestoneGenerationPrompt(topic, documentText, answers);
  const promptId = milestonePromptId(documentText, answers);

  const call: TextCall = { model, max_tokens: MAX_TOKENS, messages: [{ role: "user", content }] };
  await beforeCall?.(call, 2);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await anthropicClient().messages.create(call, beforeCall ? { maxRetries: 0 } : undefined);
      usage.inputTokens  += res.usage.input_tokens;
      usage.outputTokens += res.usage.output_tokens;
      const raw = res.content[0]?.type === "text" ? res.content[0].text : "{}";
      // `attempt` is 0-based; the count of attempts made is one more.
      return { parsed: parseMilestoneGeneration(raw), usage, attempts: attempt + 1, model, promptId };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("milestone generation failed");
}
