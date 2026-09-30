import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Milestone as MilestoneIcon, X } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { verifyUserAccess } from "@/lib/supabase/verify-access";
import SignOutButton from "@/components/landing/SignOutButton";
import HeaderUsage from "@/components/usage/HeaderUsage";
import AskWorkspace from "@/components/learn/AskWorkspace";
import { type LearningGoal } from "@/types";
import RecordActivity from "@/components/monitor/RecordActivity";

interface Props {
  params:       Promise<{ goalId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function StudyAskPage({ params, searchParams }: Props) {
  const { goalId } = await params;
  const sp          = await searchParams;
  const urlMilestone   = typeof sp.milestone   === "string" ? sp.milestone.trim()   : null;
  const urlMilestoneId = typeof sp.milestoneId === "string" ? sp.milestoneId.trim() : null;

  const supabase = await createClient();
  const { user } = await verifyUserAccess(supabase);

  const { data: goal } = await supabase
    .from("learning_goals")
    .select("*")
    .eq("id", goalId)
    .eq("user_id", user.id)
    .single();

  if (!goal) notFound();

  const g = goal as LearningGoal;

  // Resolve the focused milestone: explicit URL param wins, otherwise fall back
  // to the track's persistent focus so the goal stays in view across visits.
  let focusId:    string | null = urlMilestoneId;
  let focusTitle: string | null = urlMilestone;
  if (!focusId) {
    const { data: track } = await supabase
      .from("tracks")
      .select("focus_milestone_id")
      .eq("goal_id", goalId)
      .eq("user_id", user.id)
      .maybeSingle();
    const fid = (track?.focus_milestone_id as string | null) ?? null;
    if (fid) {
      const { data: ms } = await supabase
        .from("milestones")
        .select("id, title")
        .eq("id", fid)
        .maybeSingle();
      if (ms) {
        focusId    = ms.id as string;
        focusTitle = ms.title as string;
      }
    }
  }

  const initial   = (user.email ?? "").split("@")[0]?.[0]?.toUpperCase() ?? "?";
  const chatTopic = focusTitle ? `${g.topic}: ${focusTitle}` : g.topic;

  return (
    <>
      {/* Records that this surface was used today. Renders nothing. */}
      <RecordActivity feature="ask" />
      <div className="relative flex h-dvh flex-col overflow-hidden bg-[#0A0F1E] sm:h-screen">

        {/* Breathing orbs */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-breathe absolute top-0 left-0 h-[500px] w-[500px] -translate-x-1/3 -translate-y-1/3 rounded-full bg-violet-500/12 blur-3xl" />
          <div className="animate-breathe-delayed absolute bottom-0 right-0 h-[600px] w-[600px] translate-x-1/3 translate-y-1/3 rounded-full bg-sky-500/8 blur-3xl" />
        </div>

        {/* Header — back goes to the tracker board */}
        <header className="relative flex shrink-0 items-center justify-between border-b border-slate-800 px-3 py-2 sm:px-6 sm:py-3">
          <div className="flex items-center gap-3">
            <Link
              href={`/study/${goalId}/track`}
              aria-label="Back to the track board"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            >
              <ArrowLeft size={16} />
            </Link>
            <span className="font-serif text-base font-semibold text-white">Hugh.</span>
          </div>

          <div className="flex items-center gap-2 text-sm sm:gap-4">
            <HeaderUsage />
            <div className="hidden h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold text-slate-300 sm:flex">
              {initial}
            </div>
            <span className="hidden sm:block text-slate-500">{user.email}</span>
            <span className="hidden sm:block text-slate-700">|</span>
            <SignOutButton />
          </div>
        </header>

        {/* Milestone focus strip — persists with the focused milestone */}
        {focusTitle && (
          <div className="relative flex shrink-0 items-center gap-2.5 border-b border-violet-500/20 bg-violet-500/5 px-3 py-2 sm:px-6">
            <MilestoneIcon size={13} className="shrink-0 text-violet-400" />
            <span className="hidden text-xs text-slate-500 sm:inline">Focused on</span>
            <span className="rounded-full bg-violet-900/50 px-2.5 py-0.5 text-xs font-semibold text-violet-300 truncate max-w-xs">
              {focusTitle}
            </span>
            {urlMilestone && (
              <Link
                href={`/study/${goalId}/ask`}
                className="ml-auto shrink-0 text-xs text-slate-600 hover:text-slate-400 transition-colors flex items-center gap-1"
              >
                <X size={11} />
                Clear focus
              </Link>
            )}
          </div>
        )}

        {/* Chat + checklist side-rail */}
        <AskWorkspace
          topic={chatTopic}
          goalId={goalId}
          milestoneId={focusId ?? undefined}
          milestoneTitle={focusTitle ?? undefined}
        />

      </div>
    </>
  );
}
