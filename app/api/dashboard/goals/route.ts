import { readTextRequest } from "@/lib/claude/textRequest";
import { type NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { logSafeError } from "@/lib/observability/log";
import { generateTrack } from "@/lib/tracker/generate";
import { recordOperation } from "@/lib/observability/record";
import { isPackGoalBody, type PackGoalBody } from "@/lib/claude/textInput";
import { canUsePackLearn, PACK_ACCESS_REFUSED } from "@/lib/packs/access";
import { loadPack, PACK_REFUSAL_MESSAGE, refusalStatus } from "@/lib/packs/catalog";
import { recordRetiredCall, TOPIC_GOAL_MESSAGE, TOPIC_GOAL_ROUTE } from "@/lib/learn/retiredRoute";
import { CHOOSE_COURSE_HREF } from "@/lib/learn/earlierTopic";

// Since narrow Learn PR D a goal is only ever a course from the catalog: no
// typed topic, no refinement, no topic gate and no model call. The route
// still drives the one build machine (Rule 3): goal 'pending', build in
// after(), settle 'ready' or 'failed'. A pack build takes well under a
// second, but the after() work must still outlive the response.
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const input = await readTextRequest(request, "goals");
  if (input.response) return input.response;
  const body = input.body;

  if (isPackGoalBody(body)) return startCourse(userId, body);

  // A typed topic is the closed open path, most likely from a tab opened
  // before PR D. Counted with the retired routes, so phase 3 sees it too.
  await recordRetiredCall(userId, TOPIC_GOAL_ROUTE);
  return NextResponse.json(
    { error: TOPIC_GOAL_MESSAGE, chooseCourse: CHOOSE_COURSE_HREF },
    { status: 400 },
  );
}

/**
 * Start a course from the reference-pack catalog (PRD-narrow-learn.md).
 *
 * The catalog is the gate: an id that is not a machine-checked pack with
 * cards is refused with that refusal's own message, so there is no topic gate
 * and no model call. The build spends nothing, so there is no usage gate
 * either (phase 1 architecture, decision 2). It still runs through the one
 * machine (Rule 3): goal 'pending', build in after(), settle 'ready' or
 * 'failed'.
 */
async function startCourse(userId: string, body: PackGoalBody): Promise<NextResponse> {
  const supabase = await createClient();

  // Courses are open to every unblocked learner (phase 2). Read from the
  // protected profiles row, never from the request or JWT metadata.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_blocked")
    .eq("user_id", userId)
    .single();
  if (profileError) {
    logSafeError("dashboard/goals course access", profileError);
    return NextResponse.json({ error: "Hugh couldn't check course access right now. Please try again." }, { status: 503 });
  }
  if (!canUsePackLearn(profile)) {
    return NextResponse.json({ error: PACK_ACCESS_REFUSED }, { status: 403 });
  }

  const loaded = loadPack(body.packId);
  if (!loaded.ok) {
    return NextResponse.json({ error: PACK_REFUSAL_MESSAGE[loaded.reason] }, { status: refusalStatus(loaded.reason) });
  }
  const { pack, region } = loaded;

  const { data: goal, error: goalError } = await supabase
    .from("learning_goals")
    .insert({
      user_id:      userId,
      topic:        pack.subject,
      end_date:     body.end_date,
      track_status: "pending",
      region,
      source_kind:  "pack",
      pack_id:      pack.id,
      pack_version: pack.version,
    })
    .select("*")
    .single();

  if (goalError || !goal) {
    logSafeError("dashboard/goals course db", goalError);
    return NextResponse.json({ error: "Failed to save goal" }, { status: 500 });
  }

  const goalId = goal.id as string;

  after(async () => {
    const service   = createServiceClient();
    const startedAt = Date.now();
    try {
      await generateTrack(service, userId, { kind: "pack", packId: pack.id }, goalId);
      await service.from("learning_goals").update({ track_status: "ready" }).eq("id", goalId);
      await recordOperation({
        userId, operation: "track.build", outcome: "ok",
        durationMs: Date.now() - startedAt, detail: { source: "pack", packId: pack.id },
      });
    } catch (err) {
      logSafeError("dashboard/goals course build", err);
      await service.from("learning_goals").update({ track_status: "failed" }).eq("id", goalId);
      await recordOperation({
        userId, operation: "track.build", outcome: "failed",
        durationMs: Date.now() - startedAt, error: err, detail: { source: "pack", packId: pack.id },
      });
    }
  });

  return NextResponse.json({ goal, tips: [] });
}
