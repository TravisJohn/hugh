import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { verifyUserAccess } from "@/lib/supabase/verify-access";
import { getRandomPersona } from "@/lib/personas";
import { safeInternalPath } from "@/utils/safe-redirect";
import MasteryClient from "./MasteryClient";
import MasteryRealtimeClient from "./MasteryRealtimeClient";
import RecordActivity from "@/components/monitor/RecordActivity";
import { canUseRealtime } from "@/lib/mastery/realtimeAccess";

interface Props {
  params:       Promise<{ milestoneId: string }>;
  searchParams: Promise<{ returnUrl?: string; classic?: string }>;
}

export default async function MasteryPage({ params, searchParams }: Props) {
  const { milestoneId }             = await params;
  const { returnUrl: rawReturnUrl, classic } = await searchParams;

  // Sanitised once here; every downstream redirect()/client prop uses this,
  // never the raw query value.
  const returnUrl = rawReturnUrl ? safeInternalPath(rawReturnUrl, "/home/learn") : undefined;

  const supabase = await createClient();
  const { profile } = await verifyUserAccess(supabase);

  // Ownership + data fetch — include the track's goal_id so the client can
  // build a fallback URL pointing at that goal's board. The standalone
  // /tracker board this used to fall back to no longer exists.
  const { data: milestone } = await supabase
    .from("milestones")
    .select("id, title, kanban_column, mastery_validated, track_id, summary_doc, summary_doc_at, tracks!track_id!inner(user_id, goal_id)")
    .eq("id", milestoneId)
    .single();

  if (!milestone) redirect(returnUrl ?? "/home/learn");

  // Supabase types the embed as an array or an object depending on the
  // relationship it infers; normalise before reading goal_id off it.
  const embedded = (milestone as { tracks?: { goal_id?: string | null } | { goal_id?: string | null }[] }).tracks;
  const goalId   = (Array.isArray(embedded) ? embedded[0]?.goal_id : embedded?.goal_id) ?? null;

  // Where mastery sends the learner when it has nowhere better to go. The
  // board is preferred; a goal-less legacy track falls back to the goal list.
  const fallbackUrl = goalId ? `/study/${goalId}/track` : "/home/learn";

  // Guard: must be in the Mastered (done) column
  if (milestone.kanban_column !== "done") {
    redirect(returnUrl ?? fallbackUrl);
  }

  // Guard: must have at least one diary entry
  const { count } = await supabase
    .from("milestone_entries")
    .select("id", { count: "exact", head: true })
    .eq("milestone_id", milestoneId);

  if (!count || count === 0) {
    redirect(returnUrl ?? fallbackUrl);
  }

  // S3 containment: the flag enables an administrator preview only. Learners
  // use scripted mastery until Realtime accounting is server-authoritative.
  // `?classic=1` is an intentional escape
  // hatch to the original scripted flow (used by the Realtime error UI so we
  // never silently fall back mid-session).
  const realtimeEnabled = canUseRealtime(process.env.MASTERY_REALTIME_ENABLED, profile);

  if (realtimeEnabled && classic !== "1") {
    const classicUrl =
      `/mastery/${milestoneId}?classic=1` +
      (returnUrl ? `&returnUrl=${encodeURIComponent(returnUrl)}` : "");
    return (
      <>
        {/* Records that this surface was used today. Renders nothing. */}
        <RecordActivity feature="mastery" />
        <MasteryRealtimeClient
          milestoneId={milestoneId}
          milestoneTitle={milestone.title as string}
          returnUrl={returnUrl}
          fallbackUrl={fallbackUrl}
          alreadyMastered={milestone.mastery_validated as boolean}
          classicUrl={classicUrl}
          summaryDoc={(milestone as { summary_doc?: string | null }).summary_doc ?? null}
          summaryDocAt={(milestone as { summary_doc_at?: string | null }).summary_doc_at ?? null}
        />
      </>
    );
  }

  // Pick a random voice persona for this session's TTS (classic scripted flow)
  const persona = getRandomPersona();

  return (
    <MasteryClient
      milestoneId={milestoneId}
      milestoneTitle={milestone.title as string}
      personaId={persona.id}
      returnUrl={returnUrl}
      fallbackUrl={fallbackUrl}
      alreadyMastered={milestone.mastery_validated as boolean}
    />
  );
}
