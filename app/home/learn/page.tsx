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
import { documentUploadEnabled } from "@/lib/learn/documentPath";

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

  const firstName = (user.email ?? "").split("@")[0] ?? "there";
  const initial   = firstName[0]?.toUpperCase() ?? "?";

  const dateLabel = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long",
  });

  return (
    <div className="flex h-screen overflow-hidden bg-[#0F172A]">

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
        <header className="flex shrink-0 items-center justify-between border-b border-slate-800 px-8 py-4">
          <div className="flex items-center gap-4">
            <Link
              href="/home"
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition-colors"
            >
              <ArrowLeft size={14} />
              Activities
            </Link>
            <span className="text-slate-700">|</span>
            <div>
              <h1 className="text-base font-bold text-white tracking-tight">
                Welcome back, {firstName}
              </h1>
              <p className="text-xs text-slate-600">{dateLabel}</p>
            </div>
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


        {/* Usage bar — only shown to free users */}
        {quota.plan === "free" && (
          <div className={`shrink-0 border-b px-8 py-3 ${
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
              documentUpload={documentUploadEnabled()}
            />
          )}
        </div>
      </div>
    </div>
  );
}
