"use client";

import { useEffect, useRef, useState } from "react";
import { BookMarked, ChevronLeft, ChevronRight } from "lucide-react";
import { type LearningGoal } from "@/types";
import GoalCard from "./GoalCard";
import LearningCuriosityCarousel from "./LearningCuriosityCarousel";
import CourseCatalog from "./CourseCatalog";
import TopicRequestBox from "./TopicRequestBox";
import type { CatalogGroup } from "@/lib/packs/catalog";
import {
  resolveSelection, selectionQuery, startableCourseIds, type CourseSelection,
} from "@/lib/packs/selection";

// "Choose a course": the Learn picker. Learn teaches only from its catalog of
// source-checked courses (narrow Learn, phase 2), so this screen offers the
// catalog, a box to ask for a subject it doesn't have, and the learner's
// library. The open-topic form, its refinement Q&A and the document upload no
// longer appear here; their files stay until phase 3 deletes them.

interface Props {
  initialGoals: LearningGoal[];
  /** The catalog in groups, built on the server so no pack reaches the browser. */
  groups: CatalogGroup[];
  /** The group and course the URL asked for, already checked against the catalog. */
  initialSelection: CourseSelection;
}

/**
 * How many goals the library shows before folding the rest away.
 *
 * Four fits the screen alongside the catalog, which is the whole constraint:
 * this is a teaching surface, and rule 4 says it loses padding or gains
 * pagination before it gains a scrollbar.
 */
const VISIBLE_GOALS = 4;

/** How long the library takes to fade out before a page swap, and back in after. */
const PAGE_FADE_MS = 160;

export default function DashboardPanel({ initialGoals, groups, initialSelection }: Props) {
  const [goals, setGoals]         = useState<LearningGoal[]>(initialGoals);
  const [selection, setSelection] = useState<CourseSelection>(initialSelection);
  const catalogRef = useRef<HTMLDivElement>(null);

  // The library pages rather than grows. Rule 4: this screen has to fit the
  // viewport, and a list that gets longer for ever is how a teaching surface
  // quietly acquires a scrollbar. Paging keeps its height fixed no matter how
  // many goals a learner accumulates — which expanding never would.
  const [goalPage, setGoalPage] = useState(0);

  // Paging fades out, swaps, fades back in. The cards are the same size and in
  // the same place, so without it a page change is an instant relabel that the
  // eye reads as a glitch rather than as movement.
  const [pageFading, setPageFading] = useState(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
  }, []);

  // Paging, derived rather than stored. Deleting the last goal on the final
  // page would otherwise leave `goalPage` pointing past the end and the library
  // rendering empty — clamping here means the state can never be wrong, instead
  // of being corrected after the fact.
  const goalPages    = Math.max(1, Math.ceil(goals.length / VISIBLE_GOALS));
  const safeGoalPage = Math.min(goalPage, goalPages - 1);
  const pageGoals    = goals.slice(safeGoalPage * VISIBLE_GOALS, (safeGoalPage + 1) * VISIBLE_GOALS);
  const firstShown   = goals.length === 0 ? 0 : safeGoalPage * VISIBLE_GOALS + 1;
  const lastShown    = safeGoalPage * VISIBLE_GOALS + pageGoals.length;

  function goToGoalPage(next: number) {
    if (next === safeGoalPage || pageFading) return;
    setPageFading(true);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    fadeTimer.current = setTimeout(() => {
      setGoalPage(next);
      setPageFading(false);
    }, PAGE_FADE_MS);
  }

  // The open group and course live in the URL, so reloading or sharing the
  // page reopens them. replaceState rather than a navigation: nothing on the
  // server depends on the selection, so a round trip would only add a delay.
  function select(next: CourseSelection) {
    setSelection(next);
    window.history.replaceState(null, "", `${window.location.pathname}${selectionQuery(next)}`);
  }

  // A carousel slide opens its course. On a phone the catalog sits above the
  // carousel, so bring it into view or the click would seem to do nothing.
  function chooseFromCarousel(packId: string) {
    select(resolveSelection(groups, null, packId));
    catalogRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleGoalCreated(goal: LearningGoal) {
    setGoals(prev => [goal, ...prev]);
    // The new goal is prepended, so page 0 is where the learner will look for
    // the thing they just made.
    setGoalPage(0);
  }

  function handleGoalDeleted(id: string) {
    setGoals(prev => prev.filter(g => g.id !== id));
  }

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-5 sm:gap-10 sm:px-10 sm:py-9 2xl:flex-row">

      {/* ── The catalog and the library ──────────────────────────────── */}
      <div className="flex w-full min-w-0 max-w-2xl flex-col gap-6 sm:gap-10 2xl:flex-[0_1_42rem]">

      <div ref={catalogRef} className="flex flex-col gap-4">
        <CourseCatalog
          groups={groups}
          selection={selection}
          onSelect={select}
          onGoalCreated={handleGoalCreated}
        />
        <TopicRequestBox />
      </div>

      {/* ── Library ────────────────────────────────────────────────── */}
      {goals.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <BookMarked size={15} className="text-slate-500" />
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">
              My learning library
            </h2>
            <span className="ml-1 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-600 font-mono">
              {goals.length}
            </span>

            {goalPages > 1 && (
              <div className="ml-auto flex items-center gap-1.5">
                <span className="mr-1 text-xs tabular-nums text-slate-600">
                  {firstShown}–{lastShown} of {goals.length}
                </span>
                <button
                  onClick={() => goToGoalPage(safeGoalPage - 1)}
                  disabled={safeGoalPage === 0}
                  aria-label="Previous goals"
                  className="rounded-lg border border-slate-700 p-1 text-slate-500 transition-colors hover:border-slate-500 hover:text-slate-300 disabled:opacity-30 disabled:hover:border-slate-700 disabled:hover:text-slate-500"
                >
                  <ChevronLeft size={13} />
                </button>
                <button
                  onClick={() => goToGoalPage(safeGoalPage + 1)}
                  disabled={safeGoalPage >= goalPages - 1}
                  aria-label="More goals"
                  className="rounded-lg border border-slate-700 p-1 text-slate-500 transition-colors hover:border-slate-500 hover:text-slate-300 disabled:opacity-30 disabled:hover:border-slate-700 disabled:hover:text-slate-500"
                >
                  <ChevronRight size={13} />
                </button>
              </div>
            )}
          </div>
          <div
            className={`flex flex-col gap-3 transition-opacity ${
              pageFading ? "opacity-0" : "opacity-100"
            }`}
            style={{ transitionDuration: `${PAGE_FADE_MS}ms` }}
          >
            {pageGoals.map(g => (
              <GoalCard key={g.id} goal={g} onDelete={handleGoalDeleted} />
            ))}
          </div>
        </section>
      )}

      {goals.length === 0 && (
        <p className="text-sm text-slate-700 italic">
          Your library is empty — start a course above.
        </p>
      )}
      </div>

      {/* ── One idea per course, each opening its course ─────────────── */}
      <aside className="relative h-[40rem] w-full max-w-2xl 2xl:min-w-[20rem] 2xl:max-w-none 2xl:flex-[1_1_20rem]">
        <LearningCuriosityCarousel
          courseIds={startableCourseIds(groups)}
          onChooseCourse={chooseFromCarousel}
        />
      </aside>
    </div>
  );
}
