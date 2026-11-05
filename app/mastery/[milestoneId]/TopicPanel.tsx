"use client";

import { AlertCircle, CheckCircle2, Circle, Loader2, RotateCcw } from "lucide-react";
import type { MasteryTopic } from "@/lib/mastery/topics";

export type TopicListState =
  | { kind: "ready" }
  /** An older card's checklist is being built. */
  | { kind: "building" }
  /** No list. `onRetry` is absent when trying again could not help, as with a course that can't be taught. */
  | { kind: "failed"; message: string; onRetry?: () => void };

interface Props {
  topics:    MasteryTopic[];
  /** Refs the server has ticked. */
  covered:   string[];
  /** Wrong beliefs stated and not yet taken back. Any left at the end fail the card. */
  heldCount: number;
  list:      TopicListState;
}

/**
 * What to talk about, and what has been covered so far. Names only, so nothing
 * here can be read out as an answer. It never scrolls (Rule 4): at the column
 * width MasteryClient gives it, the tallest real card fits a window 600px high.
 */
export default function TopicPanel({ topics, covered, heldCount, list }: Props) {
  const done = new Set(covered);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex shrink-0 items-baseline justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Topics</p>
        {list.kind === "ready" && (
          <p className="text-xs font-semibold text-slate-400">{covered.length} of {topics.length}</p>
        )}
      </div>

      {list.kind === "building" && (
        <p className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 size={12} className="animate-spin" />
          Hugh is building the list…
        </p>
      )}

      {list.kind === "failed" && (
        <div role="alert" className="space-y-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-3">
          <p className="flex items-start gap-2 text-sm text-red-300">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-400" />
            {list.message}
          </p>
          {list.onRetry && (
            <button
              onClick={list.onRetry}
              className="flex items-center gap-1.5 text-xs font-semibold text-red-200 transition-colors hover:text-red-100"
            >
              <RotateCcw size={12} />
              Try again
            </button>
          )}
        </div>
      )}

      {list.kind === "ready" && (
        <ul className="space-y-1.5 [@media(max-height:660px)]:space-y-1">
          {topics.map(topic => {
            const ticked = done.has(topic.ref);
            return (
              <li key={topic.ref} className="flex items-start gap-2">
                {ticked
                  ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-400" aria-hidden />
                  : <Circle size={14} className="mt-0.5 shrink-0 text-slate-600" aria-hidden />}
                <span title={topic.label} className={`line-clamp-2 text-[13px] leading-snug transition-colors ${ticked ? "text-slate-500" : "text-slate-200"}`}>
                  {topic.label}
                  {ticked && <span className="sr-only"> (covered)</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {heldCount > 0 && (
        <p className="mt-3 shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
          {heldCount === 1 ? "Something you said needs" : `${heldCount} things you said need`} another look before you finish.
        </p>
      )}

      {/* The notice takes the hint's room: on the longest card there is only space for one. */}
      {list.kind === "ready" && heldCount === 0 && (
        <p className="mt-auto shrink-0 pt-3 text-xs leading-relaxed text-slate-600">
          A topic is ticked when you say something correct about it, not just its name.
        </p>
      )}
    </div>
  );
}
