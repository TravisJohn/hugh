"use client";

import { useState } from "react";
import { BookOpenCheck, Loader2, AlertTriangle } from "lucide-react";
import { type LearningGoal } from "@/types";
import type { CourseListing } from "@/lib/packs/catalog";
import { addDays } from "@/utils/dates";

// Narrow Learn, phase 1: the course catalog, shown only to an administrator
// while PACK_LEARN_ENABLED is on (lib/packs/access.ts). Starting a course posts
// a catalog id and a date; the goal comes back 'pending' and joins the library,
// where GoalCard watches the build exactly as it does for a typed topic.

interface Props {
  courses:       CourseListing[];
  onGoalCreated: (goal: LearningGoal) => void;
}

const DURATIONS = [
  { label: "2 weeks",  days: 14 },
  { label: "1 month",  days: 30 },
  { label: "3 months", days: 90 },
] as const;

export default function CourseCatalog({ courses, onGoalCreated }: Props) {
  return (
    <section>
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-300/80">
        Courses · admin preview
      </p>
      <div className="flex flex-col gap-3">
        {courses.map(listing => listing.course
          ? <CourseRow key={listing.packId} listing={listing} onGoalCreated={onGoalCreated} />
          : <BrokenCourse key={listing.packId} packId={listing.packId} problem={listing.problem} />)}
      </div>
    </section>
  );
}

function CourseRow({ listing, onGoalCreated }: {
  listing: Extract<CourseListing, { problem: null }>;
  onGoalCreated: (goal: LearningGoal) => void;
}) {
  const { course } = listing;
  const [days, setDays]         = useState<number>(30);
  const [starting, setStarting] = useState(false);
  const [error, setError]       = useState<string | null>(null);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const res  = await fetch("/api/dashboard/goals", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ packId: course.packId, end_date: addDays(days) }),
      });
      const data = await res.json().catch(() => ({})) as { goal?: LearningGoal; error?: string };
      if (!res.ok || !data.goal) {
        setError(data.error ?? "Hugh could not start this course. Nothing was saved — try again.");
        return;
      }
      onGoalCreated(data.goal);
    } catch {
      setError("Hugh could not be reached. Nothing was saved — try again.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.04] px-4 py-3">
      <div className="flex items-start gap-3">
        <BookOpenCheck size={18} className="mt-0.5 shrink-0 text-emerald-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-100">{course.subject}</p>
          <p className="mt-0.5 text-xs text-slate-400">
            {course.cardCount} cards · source-checked against {course.publishers.join(", ")} · v{course.version}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {DURATIONS.map(d => (
          <button
            key={d.days}
            onClick={() => setDays(d.days)}
            disabled={starting}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              days === d.days
                ? "border-emerald-400 bg-emerald-500/20 text-emerald-200"
                : "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200"
            }`}
          >
            {d.label}
          </button>
        ))}
        <button
          onClick={() => void start()}
          disabled={starting}
          className="ml-auto flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white transition-colors hover:bg-emerald-500 disabled:opacity-60"
        >
          {starting && <Loader2 size={12} className="animate-spin" />}
          {error ? "Try again" : "Start course"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}

function BrokenCourse({ packId, problem }: { packId: string; problem: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/5 px-4 py-3">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-400" />
      <div>
        <p className="text-sm font-semibold text-slate-200">{packId} can&apos;t be started</p>
        <p className="mt-0.5 text-xs text-slate-400">{problem}</p>
      </div>
    </div>
  );
}
