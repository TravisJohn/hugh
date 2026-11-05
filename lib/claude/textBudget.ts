import "server-only";
import type { ClaudeClient } from "./client";
import { NextResponse } from "next/server";
import { enforceUsageGate } from "@/lib/usage";
import type Anthropic from "@anthropic-ai/sdk";
import { imageReservation, type ImageCall } from "./imageInput";
import { TextInputError, textReservation, type TextCall, type TextCallGuard } from "./textInput";
import { planFailureResponse } from "./subscription/planResponses";

class TextBudgetDenied extends Error {
  constructor(public readonly response: NextResponse) {
    super("Text model budget refused");
    this.name = "TextBudgetDenied";
  }
}

/**
 * The reply for a Claude call that was refused or failed in a way the learner
 * should be told about, or null for the route's own generic failure: the
 * budget gate's refusal, an over-long input, or — in local subscription mode
 * — the plan's own reason (limit reached, signed out, …).
 */
export function textBudgetResponse(error: unknown): NextResponse | null {
  if (error instanceof TextBudgetDenied) return error.response;
  if (error instanceof TextInputError) return NextResponse.json({ error: error.message }, { status: error.status });
  return planFailureResponse(error);
}

export function textBudgetGuard(userId: string, feature: string): TextCallGuard {
  return async (call, attempts = 1) => {
    const response = await enforceUsageGate(userId, feature, textReservation(call, attempts));
    if (response) throw new TextBudgetDenied(response);
  };
}

export async function createTextMessage(client: ClaudeClient, userId: string, feature: string, call: TextCall) {
  await textBudgetGuard(userId, feature)(call);
  // Every further attempt needs its own reservation. Do not let SDK retries
  // silently multiply the call after this gate has admitted one attempt.
  return client.messages.create(call, { maxRetries: 0 });
}

/** `createTextMessage` for a call with images: same gate, same one attempt, its own size of hold. */
export async function createImageMessage(client: ClaudeClient, userId: string, feature: string, call: ImageCall) {
  const refused = await enforceUsageGate(userId, feature, imageReservation(call));
  if (refused) throw new TextBudgetDenied(refused);
  return client.messages.createWithImages(call, { maxRetries: 0 });
}

/**
 * What a call counts against the learner's allowance: fresh input plus cache
 * writes. Cache reads are left out, as they are on `learn/chat`. The plan path
 * reports most of a call's input as cache writes, so counting `input_tokens`
 * alone would log a screenshot as a handful of tokens.
 */
export function chargedInputTokens(usage: Anthropic.Usage): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
}
