import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { verifyUserAccess } from "@/lib/supabase/verify-access";
import SignOutButton from "@/components/landing/SignOutButton";
import HeaderUsage from "@/components/usage/HeaderUsage";
import DashboardPanel from "@/components/dashboard/DashboardPanel";
import { type LearningGoal } from "@/types";
import { checkSessionQuota, FREE_SESSION_LIMIT } from "@/lib/quota";
import { regionProgress, goalsInFlight, type InFlightGoal } from "@/lib/learn/progress";
import { documentUploadEnabled } from "@/lib/learn/documentPath";
import { type GroupProgress } from "@/lib/learn/constellation";

// "What do you want to learn?" — the learning dashboard. Reached by picking
// "Learn" on the top-level activity picker (/home). Opening a goal here jumps
// straight to that goal's Track board.
export default async function LearnDashboardPage() {
  const supabase = await createClient();
  const { user } = await verifyUserAccess(supabase);


  const [{ data: goals, error: goalsError }, quota] = await Promise.all([
    supabase
      .from("learning_goals")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    checkSessionQuota(supabase, user.id),
  ]);

  // A dropped error here renders as "you have no goals", which is
  // indistinguishable from having lost them. Say what actually happened.
  if (goalsError) {
    console.error("[home/learn] could not load goals:", goalsError.message);
  }

  // How lit each region of the constellation is. Three plain queries rather
  // than one nested embed: milestones and tracks have a reverse foreign key
  // between them that makes `tracks!inner(...)` ambiguous, and this read is
  // small enough that the round trips cost less than the disambiguation would.
  //
  // `null` means "we could not find out", which is NOT the same as "nothing
  // mastered" (rule 5). A dropped query must never render as a dark brain
  // telling the learner they have achieved nothing.
  let progress: GroupProgress | null = null;
  let inFlight: InFlightGoal[] = [];

  const goalRows = goals ?? [];
  const filed = goalRows.map(g => ({
    id:          g.id as string,
    topic:       g.topic as string,
    region:      (g.region ?? null) as string | null,
    trackStatus: g.track_status as string,
  }));

  // Mastery per goal, or null when it could not be read. The distinction is
  // load-bearing twice below, so it is a nullable value rather than an empty
  // array standing in for both.
  let mastery: { goalId: string; mastered: boolean }[] | null = null;

  if (!goalsError && goalRows.length > 0) {
    const { data: tracks, error: tracksError } = await supabase
      .from("tracks")
      .select("id, goal_id")
      .in("goal_id", goalRows.map(g => g.id));

    if (tracksError) {
      console.error("[home/learn] could not load tracks for progress:", tracksError.message);
    } else if ((tracks ?? []).length === 0) {
      // No tracks is a fact, not a failure: every goal is still being built.
      mastery = [];
    } else {
      const goalOfTrack = new Map((tracks ?? []).map(t => [t.id as string, t.goal_id as string]));
      const { data: milestones, error: milestonesError } = await supabase
        .from("milestones")
        .select("track_id, mastery_validated")
        .in("track_id", [...goalOfTrack.keys()]);

      if (milestonesError) {
        console.error("[home/learn] could not load milestones for progress:", milestonesError.message);
      } else {
        mastery = (milestones ?? []).flatMap(m => {
          const goalId = goalOfTrack.get(m.track_id as string);
          return goalId ? [{ goalId, mastered: Boolean(m.mastery_validated) }] : [];
        });
      }
    }
  }

  if (!goalsError) {
    // Progress stays null when mastery could not be read, so the sphere makes
    // no claim about what has been earned (rule 5).
    if (mastery !== null) progress = regionProgress(filed, mastery);

    // In-flight is decided even when mastery is unknown, and the empty list is
    // the right stand-in: it means "nothing is known to be finished", so a goal
    // stays in flight. Showing work the learner may have completed is a far
    // smaller harm than an empty sphere telling them they have nothing on.
    //
    // It also covers the ordinary case of a goal whose track is still
    // generating — no tracks row exists yet, and that is the moment it is most
    // in flight, not least.
    inFlight = goalsInFlight(filed, mastery ?? []);
  }

  const firstName = (user.email ?? "").split("@")[0] ?? "there";
  const initial   = firstName[0]?.toUpperCase() ?? "?";

  const dateLabel = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long",
  });

  return (
    <div className="flex h-dvh overflow-hidden bg-[#0F172A] sm:h-screen">

      {/* ── Left: Hugh logo ─────────────────────────────────────────── */}
      <aside className="hidden md:flex w-72 shrink-0 flex-col items-center justify-center border-r border-slate-800 bg-slate-900/60">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-sky-400/15 blur-2xl scale-150" />
          <Image
            src="/hugh-logo.png.png"
            alt="Hugh — Skill Prep App"
            width={240}
            height={240}
            className="relative object-contain drop-shadow-2xl"
            priority
          />
        </div>
      </aside>

      {/* ── Right: Dashboard ─────────────────────────────────────────── */}
      <div className="relative flex flex-1 flex-col min-w-0 overflow-hidden">

        {/* Breathing orbs behind the dashboard content */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-breathe absolute top-0 right-0 h-[500px] w-[500px] translate-x-1/3 -translate-y-1/3 rounded-full bg-sky-500/10 blur-3xl" />
          <div className="animate-breathe-delayed absolute bottom-0 left-0 h-[500px] w-[500px] -translate-x-1/3 translate-y-1/3 rounded-full bg-violet-500/8 blur-3xl" />
        </div>

        {/* Top bar */}
        <header className="flex shrink-0 items-center justify-between border-b border-slate-800 px-3 py-2 sm:px-8 sm:py-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <Link
              href="/home"
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition-colors"
            >
              <ArrowLeft size={14} />
              <span className="hidden sm:inline">Activities</span>
            </Link>
            <span className="hidden text-slate-700 sm:inline">|</span>
            <div>
              <h1 className="text-base font-bold text-white tracking-tight">
                <span className="sm:hidden">Learn</span>
                <span className="hidden sm:inline">Welcome back, {firstName}</span>
              </h1>
              <p className="hidden text-xs text-slate-600 sm:block">{dateLabel}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm sm:gap-4">
              <HeaderUsage />
            <div className="hidden h-8 w-8 items-center justify-center rounded-full bg-slate-700 text-sm font-semibold text-slate-200 sm:flex">
              {initial}
            </div>
            <span className="hidden sm:block text-slate-400">{user.email}</span>
            <span className="hidden sm:block text-slate-700">|</span>
            <SignOutButton />
          </div>
        </header>


        {/* Usage bar — only shown to free users */}
        {quota.plan === "free" && (
          <div className={`shrink-0 border-b px-3 py-2 sm:px-8 sm:py-3 ${
            quota.used >= FREE_SESSION_LIMIT
              ? "border-amber-500/20 bg-amber-500/5"
              : "border-slate-800 bg-transparent"
          }`}>
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-1 items-center gap-3">
                {/* Progress bar */}
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-700">
                  <div
                    className={`h-full rounded-full transition-all ${
                      quota.used >= FREE_SESSION_LIMIT
                        ? "bg-amber-400"
                        : quota.used >= FREE_SESSION_LIMIT * 0.8
                        ? "bg-amber-400"
                        : "bg-sky-500"
                    }`}
                    style={{ width: `${Math.min(100, (quota.used / FREE_SESSION_LIMIT) * 100)}%` }}
                  />
                </div>
                <span className="text-xs text-slate-500">
                  {quota.used} of {FREE_SESSION_LIMIT} free sessions used this month
                </span>
              </div>
              {quota.used >= FREE_SESSION_LIMIT ? (
                <Link
                  href="/upgrade"
                  className="shrink-0 rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-400 transition-colors hover:bg-amber-500/20"
                >
                  Upgrade →
                </Link>
              ) : quota.used >= FREE_SESSION_LIMIT - 1 ? (
                <Link
                  href="/upgrade"
                  className="shrink-0 text-xs text-slate-500 transition-colors hover:text-slate-400"
                >
                  See Pro →
                </Link>
              ) : null}
            </div>
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {goalsError ? (
            <div className="mx-8 mt-6 flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/5 px-5 py-4">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-400" />
              <div>
                <p className="text-sm font-semibold text-slate-200">
                  Your goals could not be loaded
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  Nothing has been lost — the list just could not be read this
                  time. Reload the page to try again.
                </p>
              </div>
            </div>
          ) : (
            <DashboardPanel
              initialGoals={(goals ?? []) as LearningGoal[]}
              regionProgress={progress}
              inFlight={inFlight}
              documentUpload={documentUploadEnabled()}
            />
          )}
        </div>
      </div>
    </div>
  );
}
