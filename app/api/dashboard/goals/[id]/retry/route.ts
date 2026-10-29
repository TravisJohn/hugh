import { type NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { generateTrack } from "@/lib/tracker/generate";
import { buildState, retryVerdict, MAX_BUILDS_PER_GOAL } from "@/lib/tracker/buildState";
import { recordOperation } from "@/lib/observability/record";
import { logSafeError } from "@/lib/observability/log";
import { canUsePackLearn, PACK_ACCESS_REFUSED } from "@/lib/packs/access";
import { loadPack, PACK_REFUSAL_MESSAGE, refusalStatus } from "@/lib/packs/catalog";
import { CHOOSE_COURSE_HREF, EARLIER_TOPIC_NO_REBUILD, isCourseGoal } from "@/lib/learn/earlierTopic";
import { type LearningGoal } from "@/types";

// Rebuild the track for a course whose build failed or died mid-flight.
//
// It reuses the exact machine the first build used: flip to 'pending',
// generate in after(), settle to 'ready' or 'failed'. The client watches it
// with the same useTrackStatusWatch hook, so there is one state machine, not
// two.
//
// Since narrow Learn PR D only a course can be rebuilt. An earlier topic
// would need the retired open-topic build, so it is refused before anything
// else, with a way out to the catalog rather than a dead end (Rule 5). A
// course rebuild lays out the pack's cards and spends nothing, so there is no
// usage gate (phase 1 architecture, decision 2); the rebuild ceiling below
// still holds.
//
// Mirrors goals/route.ts's maxDuration: the after() work must outlive the
// response.
export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  if (!isCourseGoal(g)) {
    void recordOperation({
      userId, operation: "track.retry", outcome: "refused",
      detail: { reason: "earlier-topic", source: g.source_kind },
    });
    return NextResponse.json(
      { error: EARLIER_TOPIC_NO_REBUILD, chooseCourse: CHOOSE_COURSE_HREF, verdict: "earlier-topic" },
      { status: 409 },
    );
  }

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
  // delete the track the running after() is mid-write into. Do not relax this
  // guard as a cost optimisation.
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

  // The goal row is learner-writable, so neither `source_kind` nor `pack_id`
  // is trusted here: course access is checked again, and the id must name a
  // teachable pack. Then it rebuilds from the pack, exactly as it was built.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_blocked")
    .eq("user_id", userId)
    .single();
  if (profileError) {
    logSafeError("goals/retry course access", profileError);
    return NextResponse.json({ error: "Hugh couldn't check course access right now. Please try again." }, { status: 503 });
  }
  if (!canUsePackLearn(profile)) {
    return NextResponse.json({ error: PACK_ACCESS_REFUSED }, { status: 403 });
  }
  const loaded = loadPack(g.pack_id ?? "");
  if (!loaded.ok) {
    return NextResponse.json({ error: PACK_REFUSAL_MESSAGE[loaded.reason] }, { status: refusalStatus(loaded.reason) });
  }
  const packId = loaded.pack.id;

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

      await generateTrack(service, userId, { kind: "pack", packId }, goalId);
      await service.from("learning_goals").update({ track_status: "ready" }).eq("id", goalId);
      await recordOperation({
        userId, operation: "track.retry", outcome: "ok",
        durationMs: Date.now() - rebuiltAt,
        // `source` matches what goals/route.ts records, so "which entry path
        // produces the most rebuilds?" stays answerable from one column.
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
