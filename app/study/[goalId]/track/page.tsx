import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CalendarClock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { verifyUserAccess } from "@/lib/supabase/verify-access";
import SignOutButton from "@/components/landing/SignOutButton";
import HeaderUsage from "@/components/usage/HeaderUsage";
import KanbanBoard from "@/components/tracker/KanbanBoard";
import TrackBuildPanel from "@/components/tracker/TrackBuildPanel";
import { buildState, trackViewState } from "@/lib/tracker/buildState";
import { type LearningGoal, type Track, type Milestone } from "@/types";
import RecordActivity from "@/components/monitor/RecordActivity";
import { canUseRealtime } from "@/lib/mastery/realtimeAccess";

interface Props {
  params:       Promise<{ goalId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// Whole days between today and the goal's end date. Both ends are normalised to
// local midnight so a few hours either side don't skew the count.
function daysUntil(endDate: string): number {
  const end = new Date(endDate);
  const now = new Date();
  end.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - now.getTime()) / 86_400_000);
}

export default async function StudyTrackPage({ params, searchParams }: Props) {
  const { goalId } = await params;
  const sp          = await searchParams;
  const pulseId     = typeof sp.pulse     === "string" ? sp.pulse     : undefined;
  const validatedId = typeof sp.validated === "string" ? sp.validated : undefined;
  const masteredId  = typeof sp.mastered  === "string" ? sp.mastered  : undefined;

  const supabase = await createClient();
  const { user, profile } = await verifyUserAccess(supabase);

  const [{ data: goal }, { data: track }] = await Promise.all([
    supabase.from("learning_goals").select("*").eq("id", goalId).eq("user_id", user.id).single(),
    supabase.from("tracks").select("*").eq("goal_id", goalId).eq("user_id", user.id).maybeSingle(),
  ]);

  const isPremium = (profile?.plan === "pro") || (profile?.is_admin === true);
  const isAdmin   = profile?.is_admin === true;
  const liveAvailable = canUseRealtime(process.env.MASTERY_REALTIME_ENABLED, profile);

  if (!goal) notFound();

  const g       = goal as LearningGoal;
  const t       = track as Track | null;
  const initial = (user.email ?? "").split("@")[0]?.[0]?.toUpperCase() ?? "?";

  // Load milestones only if a linked track exists
  let milestones: Milestone[] = [];
  if (t) {
    const { data: ms } = await supabase
      .from("milestones")
      .select("*")
      .eq("track_id", t.id)
      .order("position", { ascending: true });
    milestones = (ms ?? []) as Milestone[];
  }

  // What the learner is actually looking at. The goal row already carried
  // track_status; the page used to ignore it and show one "may still be
  // generating" message for every non-board case, including 'failed' — where
  // the refresh it suggested could never work.
  // This is a Server Component: it renders once per request, so "now" is a
  // request timestamp rather than a value that could shift between client
  // re-renders. The purity rule cannot tell the two apart.
  // eslint-disable-next-line react-hooks/purity
  const build = buildState(g.track_status, g.track_started_at ?? g.created_at, Date.now());
  const view  = trackViewState(build, Boolean(t), milestones.length);
  // A 'ready' goal reaching the panel means the board is missing or empty,
  // which is a failure however the row is labelled.
  const panelState = build === "ready" ? "failed" : build;

  // Days-remaining reminder — nudges amber ≤7 days out, rose once due/overdue.
  const days      = daysUntil(g.end_date);
  const daysLabel =
    days > 1   ? `${days} days left` :
    days === 1 ? "1 day left"        :
    days === 0 ? "Last day"          :
    `${Math.abs(days)} days over`;
  const daysTone =
    days <= 0 ? "bg-rose-500/10 text-rose-400"   :
    days <= 7 ? "bg-amber-500/10 text-amber-400" :
                "bg-slate-800 text-slate-400";

  return (
    <>
      {/* Records that this surface was used today. Renders nothing. */}
      <RecordActivity feature="learn" />
      <div className="flex h-screen flex-col bg-[#0F172A] overflow-hidden">

        {/* Header */}
        <header className="flex shrink-0 items-center justify-between border-b border-slate-800 px-6 py-3">
          <div className="flex items-center gap-3">
            <Link
              href="/home/learn"
              aria-label="Back to your goals"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            >
              <ArrowLeft size={16} />
            </Link>
            <span className="font-serif text-base font-semibold text-white">Hugh.</span>
          </div>

          <div className="flex items-center gap-4 text-sm">
            <HeaderUsage />
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-700 text-sm font-semibold text-slate-200">
              {initial}
            </div>
            <span className="hidden sm:block text-slate-400">{user.email}</span>
            <span className="hidden sm:block text-slate-700">|</span>
            <SignOutButton />
          </div>
        </header>

        {/* Goal context bar — the goal title plus a days-remaining reminder.
            Replaces the old Track/Ask/Converse tabs and the
            topic_description/title subtitle (both redundant now that the learner
            follows one fixed pathway). */}
        <div className="shrink-0 flex items-center gap-4 border-b border-slate-800 bg-slate-900/40 px-6 py-2.5">
          <h1 className="min-w-0 truncate text-sm font-semibold text-slate-200" title={g.topic}>
            {g.topic}
          </h1>
          <span className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold ${daysTone}`}>
            <CalendarClock size={12} />
            {daysLabel}
          </span>
        </div>

        {view === "board" && t ? (
          /* Kanban board */
          <div className="flex-1 overflow-hidden px-6 py-5">
            <KanbanBoard initialMilestones={milestones} goalId={goalId} trackId={t.id} focusMilestoneId={t.focus_milestone_id} backlogPriorityMode={t.backlog_priority_mode} pulseId={pulseId} validatedId={validatedId} masteredId={masteredId} isPremium={isPremium} isAdmin={isAdmin} liveAvailable={liveAvailable} />
          </div>
        ) : (
          <TrackBuildPanel
            goalId={goalId}
            initialState={view === "building" ? "building" : panelState}
            emptyBoard={Boolean(t) && milestones.length === 0}
          />
        )}

      </div>
    </>
  );
}
