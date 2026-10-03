import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { verifyUserAccess } from "@/lib/supabase/verify-access";
import { safeInternalPath } from "@/utils/safe-redirect";
import MasteryRealtimeClient from "./MasteryRealtimeClient";
import RecordActivity from "@/components/monitor/RecordActivity";
import { canUseRealtime } from "@/lib/mastery/realtimeAccess";

interface Props {
  params:       Promise<{ milestoneId: string }>;
  searchParams: Promise<{ returnUrl?: string }>;
}

export default async function MasteryPage({ params, searchParams }: Props) {
  const { milestoneId }             = await params;
  const { returnUrl: rawReturnUrl } = await searchParams;

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

  // S3 containment: Live voice remains an administrator preview until its
  // session accounting is owned by the server. The retired scripted flow must
  // never be used as a fallback.
  const realtimeEnabled = canUseRealtime(process.env.MASTERY_REALTIME_ENABLED, profile);

  if (realtimeEnabled) {
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
          summaryDoc={(milestone as { summary_doc?: string | null }).summary_doc ?? null}
          summaryDocAt={(milestone as { summary_doc_at?: string | null }).summary_doc_at ?? null}
        />
      </>
    );
  }

  return (
    <main className="flex h-screen items-center justify-center bg-[#0F172A] px-6 text-slate-200">
      <div className="max-w-md space-y-5 text-center">
        <h1 className="font-serif text-2xl font-semibold">Live voice mastery is unavailable</h1>
        <p className="text-sm leading-relaxed text-slate-400">
          We are finishing the usage controls before opening live sessions to learners.
          Your track and diary are safe.
        </p>
        <Link
          href={returnUrl ?? fallbackUrl}
          className="inline-flex rounded-xl bg-slate-700 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-600"
        >
          Back to track
        </Link>
      </div>
    </main>
  );
}
