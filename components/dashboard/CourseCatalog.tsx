"use client";

import { useState } from "react";
import { BookOpenCheck, Loader2, AlertTriangle, ChevronLeft, ChevronRight, Route } from "lucide-react";
import { type LearningGoal } from "@/types";
import type { CatalogGroup, CourseListing } from "@/lib/packs/catalog";
import { NO_SELECTION, type CourseSelection } from "@/lib/packs/selection";
import { addDays } from "@/utils/dates";

// The course picker (narrow Learn). It shows one group at a time rather than
// every course on one screen (PRD phase 2, decision 5): first the groups, then
// one group's courses as compact rows. Only the selected course carries the
// duration chips and Start button, which is what keeps a group short.
//
// Starting a course posts a catalog id and a date; the goal comes back
// 'pending' and joins the library, where GoalCard watches the build.
//
// The groups arrive as plain data from the server. Nothing here imports the
// catalog at runtime, so no pack is bundled into the browser.

interface Props {
  groups:        CatalogGroup[];
  selection:     CourseSelection;
  onSelect:      (selection: CourseSelection) => void;
  onGoalCreated: (goal: LearningGoal) => void;
}

const DURATIONS = [
  { label: "2 weeks",  days: 14 },
  { label: "1 month",  days: 30 },
  { label: "3 months", days: 90 },
] as const;

/** At most two publishers by name, so a row stays one line. */
function publisherLine(publishers: readonly string[]): string {
  if (publishers.length <= 2) return publishers.join(" and ");
  return `${publishers.slice(0, 2).join(", ")} and ${publishers.length - 2} more`;
}

export default function CourseCatalog({ groups, selection, onSelect, onGoalCreated }: Props) {
  const open = groups.find(g => g.group.id === selection.groupId) ?? null;

  return (
    <section>
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-300/80">
        Courses
      </p>
      {open
        ? <GroupView group={open} selectedPackId={selection.packId} onSelect={onSelect} onGoalCreated={onGoalCreated} />
        : <GroupList groups={groups} onSelect={onSelect} />}
    </section>
  );
}

function GroupList({ groups, onSelect }: { groups: CatalogGroup[]; onSelect: Props["onSelect"] }) {
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-100">Choose a course</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">
        Every course follows a source-checked syllabus. Pick a group to see its courses.
      </p>
      {groups.length === 0 ? (
        // An empty list can only mean an empty catalog: a broken course is
        // listed as broken, never dropped (lib/packs/catalog.ts).
        <p className="mt-5 text-sm text-slate-500">No courses are available right now.</p>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {groups.map(({ group, listings }) => (
            <button
              key={group.id}
              type="button"
              onClick={() => onSelect({ groupId: group.id, packId: null })}
              className="group flex flex-col rounded-2xl border border-slate-700/80 bg-slate-800/40 px-4 py-3 text-left transition-colors hover:border-emerald-500/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-100">{group.label}</span>
                <ChevronRight size={15} className="shrink-0 text-slate-500 transition-colors group-hover:text-emerald-300" />
              </span>
              <span className="mt-1 text-xs leading-relaxed text-slate-400">{group.blurb}</span>
              <span className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                {group.path && <Route size={11} className="text-emerald-300/80" />}
                {listings.length} {listings.length === 1 ? "course" : "courses"}
                {group.path && " · a path, in order"}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function GroupView({ group: { group, listings }, selectedPackId, onSelect, onGoalCreated }: {
  group:          CatalogGroup;
  selectedPackId: string | null;
  onSelect:       Props["onSelect"];
  onGoalCreated:  Props["onGoalCreated"];
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(NO_SELECTION)}
        className="mb-2 flex items-center gap-1 text-xs text-slate-500 transition-colors hover:text-slate-300"
      >
        <ChevronLeft size={13} />
        All groups
      </button>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-100">{group.label}</h2>
      <p className="mt-1 text-sm leading-relaxed text-slate-400">{group.blurb}</p>
      <ol className="mt-4 flex flex-col gap-2">
        {listings.map((listing, index) => (
          <li key={listing.packId}>
            {listing.course ? (
              <CourseRow
                listing={listing}
                step={group.path ? index + 1 : null}
                selected={listing.packId === selectedPackId}
                onToggle={() => onSelect({
                  groupId: group.id,
                  packId:  listing.packId === selectedPackId ? null : listing.packId,
                })}
                onGoalCreated={onGoalCreated}
              />
            ) : (
              <BrokenCourse packId={listing.packId} problem={listing.problem} />
            )}
          </li>
        ))}
      </ol>
    </>
  );
}

function CourseRow({ listing, step, selected, onToggle, onGoalCreated }: {
  listing:       Extract<CourseListing, { problem: null }>;
  /** The course's place in a path, or null outside one. */
  step:          number | null;
  selected:      boolean;
  onToggle:      () => void;
  onGoalCreated: Props["onGoalCreated"];
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
    <div className={`rounded-2xl border px-4 py-2.5 transition-colors ${
      selected ? "border-emerald-500/40 bg-emerald-500/[0.06]" : "border-slate-700/70 bg-slate-800/30"
    }`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={selected}
        className="flex w-full items-center gap-3 text-left"
      >
        {step !== null ? (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-emerald-500/40 text-[11px] font-semibold tabular-nums text-emerald-200">
            {step}
          </span>
        ) : (
          <BookOpenCheck size={16} className="shrink-0 text-emerald-300" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-100">{course.subject}</span>
          <span className="block truncate text-xs text-slate-400">
            {course.cardCount} cards · checked against {publisherLine(course.publishers)}
          </span>
        </span>
        <ChevronRight size={15} className={`shrink-0 text-slate-500 transition-transform ${selected ? "rotate-90" : ""}`} />
      </button>

      {selected && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {DURATIONS.map(d => (
              <button
                key={d.days}
                type="button"
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
              type="button"
              onClick={() => void start()}
              disabled={starting}
              className="ml-auto flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white transition-colors hover:bg-emerald-500 disabled:opacity-60"
            >
              {starting && <Loader2 size={12} className="animate-spin" />}
              {error ? "Try again" : "Start course"}
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
        </>
      )}
    </div>
  );
}

function BrokenCourse({ packId, problem }: { packId: string; problem: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/5 px-4 py-2.5">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-400" />
      <div>
        <p className="text-sm font-semibold text-slate-200">{packId} can&apos;t be started</p>
        <p className="mt-0.5 text-xs text-slate-400">{problem}</p>
      </div>
    </div>
  );
}
