import type { TextCall, TextCallGuard } from "@/lib/claude/textInput";
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { topicDomainJudgePrompt, parseClaudeJson } from "@/lib/claude/prompts";
import {
  type TopicDomainVerdict,
  normalizeVerdict,
  mayProceed,
} from "@/lib/learn/topic-domain";
import { logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { messageOf } from "@/lib/observability/sanitize";
import { logSafeError } from "@/lib/observability/log";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for the domain gate — see CLAUDE.md "Model Selection". Declared once
// so the API call and the usage log cannot disagree about what was billed.
const MODEL = "claude-haiku-4-5";

/**
 * Server-side core of the topic domain gate (see `lib/learn/topic-domain.ts`
 * for the client-facing fetch wrapper and the full domain-gate rationale).
 * Factored out so it can be called in-process — no HTTP round-trip — by any
 * server route that already has a candidate topic, not just the
 * `classify-topic` route. Used by the document-upload `extract` route
 * (PRD-course-from-document.md §6 layer 3) to gate document-derived topics
 * the same way a typed topic is gated.
 *
 * A network or parse failure is retryable and never approves a track.
 *
 * `userId` is required, not optional: this call spends tokens at every call
 * site, and an optional parameter is how a future caller forgets to bill them.
 *
 * `previousAttempts` are earlier phrasings this learner has already been asked
 * to narrow, so the judge can stop re-offering suggestions they have turned
 * down. Context for the reply only — the prompt states plainly that they carry
 * no weight in the verdict. Callers must pass topics that have been through
 * `checkTopic`, exactly as with `topic`.
 */
export async function judgeTopicDomain(
  topic:            string,
  userId:           string,
  previousAttempts: readonly string[] = [],
  beforeCall?: TextCallGuard,
): Promise<TopicDomainVerdict> {
  const prompt = topicDomainJudgePrompt(topic, previousAttempts);

  const call: TextCall = { model: MODEL, max_tokens: 600, messages: [{ role: "user", content: prompt }] };
  // Budget denials must propagate, never enter the classifier retry loop.
  await beforeCall?.(call, 2);

  const startedAt = Date.now();

  let lastErr: unknown = null;
  // Accumulated across attempts: a discarded first attempt still costs money.
  let tokensIn  = 0;
  let tokensOut = 0;

  const bill = () => {
    if (tokensIn === 0 && tokensOut === 0) return;
    void logUsage({ userId, model: MODEL, feature: "learn/topic-domain", tokensIn, tokensOut });
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msg = await anthropic.messages.create(call, beforeCall ? { maxRetries: 0 } : undefined);
      tokensIn  += msg.usage.input_tokens;
      tokensOut += msg.usage.output_tokens;
      const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
      // All malformed-output and shape rules live in normalizeVerdict (pure, unit
      // tested in topic-domain.test.ts) so the browser wrapper and this judge
      // cannot disagree about what a malformed response means.
      const verdict = normalizeVerdict(parseClaudeJson<unknown>(text));
      if (verdict.verdict === "unavailable") throw new Error(`Malformed topic verdict: ${verdict.reason}`);
      bill();
      // 'refused' for anything that did not proceed: the gate turning someone
      // away is the gate working, and counting it as a failure would make a
      // week of off-topic requests read as an outage.
      //
      // 'needs_angle' shares the 'refused' outcome rather than earning a fourth
      // one, because outcome is a CHECK constraint ('ok','failed','refused')
      // and a new value would mean a migration for a distinction that is not
      // operational — nothing broke either way. The verdict rides in `detail`,
      // where the two can still be told apart when reading the numbers.
      await recordOperation({
        userId,
        operation:  "topic.gate",
        outcome:    mayProceed(verdict) ? "ok" : "refused",
        durationMs: Date.now() - startedAt,
        detail:     {
          attempts:  attempt + 1,
          verdict:   verdict.verdict,
          // Distinct from `attempts` above, which counts model retries. This
          // is how many earlier phrasings the learner had already been asked
          // to narrow — the number that says whether the gate is looping.
          priorTries: previousAttempts.length,
        },
      });
      return verdict;
    } catch (err) {
      lastErr = err;
    }
  }

  logSafeError("topic-domain-server judge", lastErr, [topic]);
  bill();

  // Both attempts failed; report the outage and let the learner retry later.
  //
  // Wrapped in a named error so error_class groups on the operational meaning
  // ("the classifier is unavailable") rather than on whichever network error
  // happened to surface, while the original message survives in the note.
  const unavailable  = new Error(`classifier unavailable: ${messageOf(lastErr)}`);
  unavailable.name   = "ClassifierUnavailable";

  await recordOperation({
    userId,
    operation:  "topic.gate",
    outcome:    "failed",
    durationMs: Date.now() - startedAt,
    error:      unavailable,
    redact:     [topic],
    detail:     { attempts: 2 },
  });

  throw unavailable;
}
