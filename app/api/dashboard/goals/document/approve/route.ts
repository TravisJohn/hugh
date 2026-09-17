import { type NextRequest, NextResponse, after } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { documentUploadEnabled, DOCUMENT_EXPIRED_MESSAGE, DOCUMENT_UPLOAD_LOCKED_MESSAGE } from "@/lib/learn/documentPath";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { judgeTopicDomain } from "@/lib/learn/topic-domain-server";
import { mayProceed } from "@/lib/learn/topic-domain";
import { logSafeError } from "@/lib/observability/log";
import { generateTrack } from "@/lib/tracker/generate";
import { recordOperation } from "@/lib/observability/record";

// Second half of the document-upload path (PRD-course-from-document.md §7.1).
// The learner has reviewed — and possibly edited — the candidate topic from
// `extract`. This re-gates it, flips the goal to 'pending', and generates
// the track exactly like the Q&A path does from here, grounded in the
// document text `extract` stored. Mirrors goals/route.ts's after()/
// maxDuration shape, since this also chains a background generateTrack call.
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  // The document path is locked (see lib/learn/documentPath.ts). Refused here
  // rather than only hidden in the UI: this endpoint is reachable directly, and
  // a check that only runs in the browser is not a check.
  if (!documentUploadEnabled()) {
    return NextResponse.json({ error: DOCUMENT_UPLOAD_LOCKED_MESSAGE }, { status: 403 });
  }

  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body   = (await request.json()) as { goalId?: string; topic?: string };
  const goalId = body.goalId?.trim();
  const topic  = body.topic?.trim();
  if (!goalId) return NextResponse.json({ error: "goalId is required" }, { status: 400 });
  if (!topic) return NextResponse.json({ error: "topic is required" }, { status: 400 });
  if (topic.length > 200) return NextResponse.json({ error: "topic is too long" }, { status: 400 });

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
  if (goal.source_kind !== "document" || goal.track_status !== "awaiting_approval") {
    return NextResponse.json({ error: "This goal isn't awaiting approval." }, { status: 409 });
  }

  // The document text must still exist. The retention job (migration 052)
  // clears it after a window without approval, and without this check the build
  // below would quietly ground the track in the topic alone — a different
  // product from the one the learner asked for, with nothing saying so. Checked
  // before the topic gate so a refusal spends no tokens.
  const { data: pendingText, error: pendingError } = await supabase
    .from("pending_document_extractions")
    .select("goal_id")
    .eq("goal_id", goalId)
    .maybeSingle();

  if (pendingError) {
    logSafeError("goals/document/approve pending text", pendingError, [topic]);
    return NextResponse.json({ error: "Couldn't check your document. Please try again." }, { status: 500 });
  }
  if (!pendingText) {
    return NextResponse.json({ error: DOCUMENT_EXPIRED_MESSAGE }, { status: 410 });
  }

  // Re-gate: the learner may have edited the topic since extraction. A human
  // editing a field doesn't get to skip the same check a machine-derived
  // topic goes through — this closes the edit-bypass gap (PRD §6/§7.1).
  const verdict = await judgeTopicDomain(topic, userId);
  if (!mayProceed(verdict)) {
    return NextResponse.json(verdict);
  }

  // track_started_at is stamped here, not at insert time: a document goal sits
  // at 'awaiting_approval' until the learner approves it, which may be much
  // later. Stall detection has to measure from when the build actually began.
  const startedAt = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("learning_goals")
    // Filed here rather than at extraction (migration 051), for the same reason
    // track_started_at is: this is the point where the FINAL topic is known and
    // has just been judged. A learner who edited the extracted topic gets the
    // region their edit earned, not the one the document suggested.
    .update({
      topic,
      track_status:     "pending",
      track_started_at: startedAt,
      region:           verdict.region ?? null,
    })
    .eq("id", goalId);

  if (updateError) {
    logSafeError("goals/document/approve pending", updateError, [topic]);
    return NextResponse.json({ error: "Failed to start track generation." }, { status: 500 });
  }

  // Generation runs post-response, same as the Q&A path. A service-role
  // client is used because the cookie-bound request client isn't guaranteed
  // usable once the response lifecycle has ended.
  after(async () => {
    const service   = createServiceClient();
    const startedAt = Date.now();
    try {
      const { data: pending } = await service
        .from("pending_document_extractions")
        .select("extracted_text")
        .eq("goal_id", goalId)
        .maybeSingle();

      await generateTrack(service, userId, topic, goalId, pending?.extracted_text as string | undefined);
      await service.from("learning_goals").update({ track_status: "ready" }).eq("id", goalId);
      await recordOperation({
        userId, operation: "track.build", outcome: "ok",
        durationMs: Date.now() - startedAt, detail: { source: "document" },
      });
    } catch (err) {
      logSafeError("goals/document/approve background build", err, [topic]);
      await service.from("learning_goals").update({ track_status: "failed" }).eq("id", goalId);
      await recordOperation({
        userId, operation: "track.build", outcome: "failed",
        durationMs: Date.now() - startedAt, error: err, redact: [topic],
        detail: { source: "document" },
      });
    } finally {
      // The extracted document text's job is done once generateTrack has
      // read it — it doesn't linger in the database after the track exists.
      await service.from("pending_document_extractions").delete().eq("goal_id", goalId);
    }
  });

  return NextResponse.json({ goal: { ...goal, topic, track_status: "pending", track_started_at: startedAt } });
}
