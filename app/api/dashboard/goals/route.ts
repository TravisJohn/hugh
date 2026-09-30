import { readTextRequest } from "@/lib/claude/textRequest";
import { createTextMessage, textBudgetResponse, textBudgetGuard } from "@/lib/claude/textBudget";
import { type NextRequest, NextResponse, after } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { logUsage } from "@/lib/usage";
import { refineTopicPrompt, parseTopicRefinement } from "@/lib/claude/prompts";
import { checkTopic, TOPIC_REJECTION_MESSAGE } from "@/lib/learn/topicInput";
import { logSafeError } from "@/lib/observability/log";
import { judgeTopicDomain } from "@/lib/learn/topic-domain-server";
import { mayProceed } from "@/lib/learn/topic-domain";
import { generateTrack } from "@/lib/tracker/generate";
import { recordOperation } from "@/lib/observability/record";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model for this route — see CLAUDE.md "Model Selection". Kept in one place so
// the API call and the usage log can never disagree about what was billed.
const MODEL = "claude-sonnet-4-6";

// Track generation runs post-response via `after()` and chains two Claude
// calls (milestones + backlog priority), so the invocation must outlive the
// response. With Fluid Compute (default-on) Hobby allows up to 300s; 120s gives
// comfortable headroom over the ~30-90s build while staying under the client's
// 180s watchdog in RefinementFlow so a slow build can't trigger a false failure.
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const input = await readTextRequest(request, "goals");
  if (input.response) return input.response;
  const body = input.body;

  const end_date = body.end_date?.trim();
  const answers  = body.answers ?? [];

  // The boundary — same check the client and classify-topic run, so a topic
  // cannot arrive here longer or more structured than either of those allow.
  const checked = checkTopic(body.topic ?? "");
  if (!checked.ok) {
    return NextResponse.json(
      { error: TOPIC_REJECTION_MESSAGE[checked.rejection] },
      { status: 400 },
    );
  }
  const topic = checked.topic;

  if (!end_date) {
    return NextResponse.json({ error: "end_date is required" }, { status: 400 });
  }

  const supabase = await createClient();

  let finalTopic = topic;
  let tips: string[] = [];

  // Step 1: refine topic + get expert tips from Q&A answers
  if (answers.length > 0) {
    try {
      const prompt = refineTopicPrompt(topic, answers);
      const msg    = await createTextMessage(anthropic, userId, "dashboard/refine-topic", {
        model:      MODEL,
        max_tokens: 600,
        messages:   [{ role: "user", content: prompt }],
      });
      void logUsage({
        userId,
        model:     MODEL,
        feature:   "dashboard/refine-topic",
        tokensIn:  msg.usage.input_tokens,
        tokensOut: msg.usage.output_tokens,
      });
      const text   = msg.content[0]?.type === "text" ? msg.content[0].text : "";
      // Validated, not trusted. The refined topic becomes the goal's topic, the
      // track's description, and the tutor's system prompt, so it goes through
      // the same boundary the typed topic did — see parseTopicRefinement.
      const result = parseTopicRefinement(text);
      finalTopic = result.refinedTopic;
      tips       = result.tips;
    } catch (err) {
      const refusal = textBudgetResponse(err);
      if (refusal) {
        void recordOperation({ userId: userId, operation: "track.build", outcome: "refused", detail: { reason: "text-admission" } });
        return refusal;
      }
      // Deliberately swallowed: refinement is an improvement, not a
      // requirement, and losing it should not cost the learner their goal.
      // `finalTopic` stays as the typed topic, which checkTopic already
      // normalised and bounded above.
      logSafeError("dashboard/goals refinement", err, [topic, ...answers.map(a => a.answer)]);
    }
  }

  // Step 1b: re-gate server-side. The client calls classify-topic before it
  // gets here, but a check that only runs in the browser is not a gate — this
  // endpoint is reachable directly. It also re-judges the *refined* topic
  // rather than the typed one, because refinement is what actually becomes the
  // curriculum. Same rule the document path already enforces in approve.
  let verdict;
  try {
    verdict = await judgeTopicDomain(finalTopic, userId, [], textBudgetGuard(userId, "learn/topic-domain"));
  } catch (err) {
    const refusal = textBudgetResponse(err);
    if (refusal) {
      void recordOperation({ userId: userId, operation: "track.build", outcome: "refused", detail: { reason: "text-admission" } });
      return refusal;
    }
    throw err;
  }
  if (!mayProceed(verdict)) {
    return NextResponse.json(verdict, { status: 422 });
  }

  // Step 2: create the learning goal with track_status = 'pending'.
  // The response returns here — the track is built afterwards in `after()`.
  const { data: goal, error: goalError } = await supabase
    .from("learning_goals")
    // `region` files this goal on the learner's map (migration 051). It comes
    // from the verdict just above rather than from the request body: the client
    // never gets to say which region its goal belongs to, and a gate that
    // failed open carries none, so the goal stays unfiled instead of guessed.
    .insert({
      user_id:      userId,
      topic:        finalTopic,
      end_date,
      track_status: "pending",
      region:       verdict.region ?? null,
    })
    .select("*")
    .single();

  if (goalError || !goal) {
    logSafeError("dashboard/goals db", goalError, [finalTopic, topic]);
    return NextResponse.json({ error: "Failed to save goal" }, { status: 500 });
  }

  const goalId = goal.id as string;

  // Step 2b: keep the answers (migration 048). Until now they produced a
  // 5-10 word refined title and were discarded, so nothing downstream could be
  // evaluated against the context it was built from.
  //
  // Written before the response returns, so `after()` can measure them. The
  // write is checked but not fatal: losing an eval sample is a smaller harm
  // than losing the learner the goal they just spent five questions on, and
  // `answer_count` on the generation row records how many actually landed.
  if (answers.length > 0) {
    const { error: answerError } = await supabase.from("goal_answers").insert(
      answers.map((a, position) => ({
        user_id:  userId,
        goal_id:  goalId,
        position,
        question: String(a.question ?? ""),
        answer:   String(a.answer ?? ""),
      })),
    );
    if (answerError) {
      logSafeError("dashboard/goals answers", answerError, [topic, ...answers.map(a => a.answer)]);
    }
  }

  // Step 3: generate the track AFTER the response is sent. The frontend watches
  // learning_goals.track_status over Realtime to know when this completes.
  // A service-role client is used because the cookie-bound request client is
  // not guaranteed to be usable once the response lifecycle has ended.
  after(async () => {
    const service   = createServiceClient();
    const startedAt = Date.now();
    try {
      await generateTrack(service, userId, finalTopic, goalId, undefined, {
        beforeGeneration: textBudgetGuard(userId, "tracker/generate"),
        beforePriority: textBudgetGuard(userId, "tracker/priority"),
      });
      await service
        .from("learning_goals")
        .update({ track_status: "ready" })
        .eq("id", goalId);
      // Awaited, not voided: a floating promise inside after() can be cut off
      // when the invocation ends, losing exactly the rows that matter most.
      await recordOperation({
        userId, operation: "track.build", outcome: "ok",
        durationMs: Date.now() - startedAt, detail: { source: "qa" },
      });
    } catch (err) {
      logSafeError("dashboard/goals background build", err, [finalTopic, topic]);
      await service
        .from("learning_goals")
        .update({ track_status: "failed" })
        .eq("id", goalId);
      await recordOperation({
        userId, operation: "track.build", outcome: "failed",
        durationMs: Date.now() - startedAt, error: err, redact: [finalTopic, topic],
        detail: { source: "qa" },
      });
    }
  });

  return NextResponse.json({ goal, tips });
}
