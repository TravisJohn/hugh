import { type NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { enforceUsageGate } from "@/lib/usage";
import { textBudgetGuard, textBudgetResponse } from "@/lib/claude/textBudget";
import { checkTopic } from "@/lib/learn/topicInput";
import { judgeTopicDomain } from "@/lib/learn/topic-domain-server";
import { mayProceed } from "@/lib/learn/topic-domain";
import { generateTrack } from "@/lib/tracker/generate";
import { buildState, retryVerdict, MAX_BUILDS_PER_GOAL } from "@/lib/tracker/buildState";
import { recordOperation } from "@/lib/observability/record";
import { logSafeError } from "@/lib/observability/log";
import { type LearningGoal } from "@/types";

// Rebuild the track for a goal whose build failed or died mid-flight.
//
// Before this existed the only remedy was "remove and re-add", which threw
// away the goal and made the learner re-run the whole Q&A refinement — a
// second Sonnet call for information they had already given. This reuses the
// exact machine the first build used: flip to 'pending', generate in after(),
// settle to 'ready' or 'failed'. The client watches it with the same
// useTrackStatusWatch hook, so there is one state machine, not two.
//
// Mirrors goals/route.ts and document/approve's maxDuration for the same
// reason: the after() work must outlive the response.
export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // A retry spends a full track-generation call, so it is gated like any
  // other spend. Without this, a failing build would be an unmetered loop.
  const usageGate = await enforceUsageGate(userId, "tracker/generate");
  if (usageGate) {
    void recordOperation({
      userId, operation: "track.retry", outcome: "refused",
      // No `source` here, deliberately: this refusal happens before the goal
      // is loaded, and loading it just to label a budget refusal would add a
      // query to the one path that is meant to spend nothing.
      detail: { reason: "usage-gate" },
    });
    return usageGate;
  }

  const { id: goalId } = await params;
  const supabase = await createClient();

  const { data: goal, error: goalError } = await supabase
    .from("learning_goals")
    .select("*")
    .eq("id", goalId)
    .eq("user_id", userId)
    .maybeSingle();

  if (goalError || !goal) {
    return NextResponse.json({ error: "Goal not found." }, { status: 404 });
  }

  const g = goal as LearningGoal;

  // "Does a usable board already exist?" is part of the decision: a goal can
  // read 'ready' and still have no track, or a track with nothing on it.
  const { data: track } = await supabase
    .from("tracks")
    .select("id")
    .eq("goal_id", goalId)
    .eq("user_id", userId)
    .maybeSingle();

  // How many times this goal has actually been generated, failures included.
  // Service-role because `track_generations` has RLS enabled and no policy: it
  // is operator data, and the learner cannot read their own rows.
  //
  // A head-count, so none of that table's learner-derived text is loaded to
  // answer a question that is only ever a number. `is_replay` is excluded
  // because an offline eval run is not something the learner did, and must
  // never eat their allowance.
  const { count: buildCount, error: buildCountError } = await createServiceClient()
    .from("track_generations")
    .select("id", { count: "exact", head: true })
    .eq("goal_id", goalId)
    .eq("is_replay", false);

  if (buildCountError) logSafeError("goals/retry build count", buildCountError);

  let milestoneCount = 0;
  if (track) {
    const { count } = await supabase
      .from("milestones")
      .select("id", { count: "exact", head: true })
      .eq("track_id", track.id as string);
    milestoneCount = count ?? 0;
  }

  // The same rule the UI uses to decide whether to show the button. Enforced
  // here too, and what it protects is learner data, not just spend.
  //
  // The rebuild below deletes the track row. `milestones` cascades off
  // `tracks`, and `milestone_entries` (the learning diary) and
  // `point_status_events` cascade off `milestones` — so one DELETE takes the
  // whole board and everything the learner wrote on it. There is no rollback
  // tooling and nothing to restore from. A rebuild is destructive and
  // irreversible, not merely expensive.
  //
  // That makes each refusal below load-bearing. 'nothing-wrong' is the branch
  // standing between a stale tab and the diary of a track that was never
  // broken; 'still-building' stops a rebuild racing a live one, which would
  // delete the track the running after() is mid-write into. The second Sonnet
  // call these also avoid is the cheap half of what they are doing. Do not
  // relax this guard as a cost optimisation.
  const state   = buildState(g.track_status, g.track_started_at ?? g.created_at, Date.now());
  // A failed count reads as 0, which allows the rebuild. That is deliberate:
  // the ceiling exists to stop a runaway loop, and refusing a legitimate
  // rebuild because a telemetry query blipped would break the learner's only
  // way out of a broken track to protect a budget rule.
  const verdict = retryVerdict(state, Boolean(track) && milestoneCount > 0, buildCount ?? 0);

  if (verdict !== "allow") {
    // Each of the three 409s is the server declining correctly - a stale tab
    // trying to restart a live build, a goal that needs approving, a track
    // that is already fine. The verdict rides along so the panel can show
    // which refusal dominates without a second query.
    void recordOperation({
      userId, operation: "track.retry", outcome: "refused",
      detail: { verdict, state, source: g.source_kind },
    });

    const reason =
      verdict === "still-building"  ? "This track is still building - give it a moment." :
      verdict === "needs-approval"  ? "This goal is waiting for you to approve its topic." :
      verdict === "rebuild-limit"   ? `This track has been rebuilt ${MAX_BUILDS_PER_GOAL} times without succeeding. Remove the goal and add it again to start over.` :
                                      "This track is fine - there is nothing to rebuild.";
    return NextResponse.json({ error: reason, verdict }, { status: 409 });
  }

  // A stored goal is not proof that its topic passed the gate. RLS lets an
  // authenticated learner create their own goal row directly, and retry used
  // to send that row straight to generation. Recheck before changing state or
  // deleting any partial track. The ordinary create path makes the same call.
  const checkedTopic = checkTopic(g.topic);
  if (!checkedTopic.ok) {
    return NextResponse.json({
      error: "This goal's topic cannot be checked. Start a new learning track with a shorter, clear topic.",
    }, { status: 422 });
  }
  if (checkedTopic.topic !== g.topic) {
    return NextResponse.json({
      error: "This stored topic contains unsupported formatting. Start a new learning track with a clear, single-line topic.",
    }, { status: 422 });
  }

  let topicVerdict;
  try {
    topicVerdict = await judgeTopicDomain(
      checkedTopic.topic, userId, [], textBudgetGuard(userId, "learn/topic-domain"),
    );
  } catch (err) {
    const refusal = textBudgetResponse(err);
    if (refusal) return refusal;
    return NextResponse.json({
      error: "Hugh couldn't check this topic right now. Please try rebuilding later.",
    }, { status: 503 });
  }
  if (!mayProceed(topicVerdict)) {
    return NextResponse.json({
      error: topicVerdict.verdict === "needs_angle"
        ? "This topic needs a clearer data angle. Start a new learning track so Hugh can ask what you mean."
        : topicVerdict.message || "This topic sits outside Hugh's data and analytics focus.",
    }, { status: 422 });
  }

  const startedAt = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("learning_goals")
    .update({ track_status: "pending", track_started_at: startedAt })
    .eq("id", goalId)
    .eq("user_id", userId);

  if (updateError) {
    logSafeError("goals/retry pending", updateError, [g.topic]);
    return NextResponse.json({ error: "Could not start the rebuild." }, { status: 500 });
  }

  after(async () => {
    const service   = createServiceClient();
    const rebuiltAt = Date.now();
    try {
      // A previous attempt can leave a track row behind — generateTrack only
      // cleans up its own partial write, and an earlier build may have
      // succeeded at the track row and failed later. Clearing first keeps the
      // goal to one track, so the board never has two to choose between.
      const { error: clearError } = await service
        .from("tracks")
        .delete()
        .eq("goal_id", goalId)
        .eq("user_id", userId);

      if (clearError) {
        throw new Error(`could not clear the previous track: ${clearError.message}`);
      }

      await generateTrack(service, userId, g.topic, goalId);
      await service.from("learning_goals").update({ track_status: "ready" }).eq("id", goalId);
      await recordOperation({
        userId, operation: "track.retry", outcome: "ok",
        durationMs: Date.now() - rebuiltAt,
        // `source` matches what goals/route.ts and document/approve record, so
        // "which entry path produces the most rebuilds?" is answerable from
        // one column instead of a join nobody will write. A rebuild of a
        // document-sourced goal is also a materially different operation: the
        // extracted text was deleted after the first read, so it regenerates
        // from the topic alone.
        detail: { previousState: state, source: g.source_kind },
      });
    } catch (err) {
      logSafeError("goals/retry background rebuild", err, [g.topic]);
      await service.from("learning_goals").update({ track_status: "failed" }).eq("id", goalId);
      await recordOperation({
        userId, operation: "track.retry", outcome: "failed",
        durationMs: Date.now() - rebuiltAt, error: err, redact: [g.topic],
        detail: { previousState: state, source: g.source_kind },
      });
    }
  });

  return NextResponse.json({
    goal: { ...g, track_status: "pending", track_started_at: startedAt },
  });
}
