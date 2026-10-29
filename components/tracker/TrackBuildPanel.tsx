"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, AlertTriangle, RotateCcw, ArrowLeft } from "lucide-react";
import { useTrackStatusWatch } from "@/hooks/useTrackStatusWatch";
import { canRebuild, type BuildState } from "@/lib/tracker/buildState";
import { CHOOSE_COURSE_HREF, CHOOSE_COURSE_LABEL, EARLIER_TOPIC_NO_REBUILD } from "@/lib/learn/earlierTopic";

interface Props {
  goalId:       string;
  /** Server-resolved state at render time. The panel takes over from here. */
  initialState: Exclude<BuildState, "ready">;
  /** True when a track row exists but has no milestones on it. */
  emptyBoard:   boolean;
  /** Whether the goal is a catalog course. Only a course can be rebuilt. */
  isCourse:     boolean;
}

// Everything the track page shows when there is no usable board.
//
// This replaces a single fallback that said "your plan may still be
// generating, refresh in a moment" for every non-board state — including
// 'failed', where refreshing could never work and the learner could sit there
// forever. Three states now, and only one of them asks the learner to wait.
export default function TrackBuildPanel({ goalId, initialState, emptyBoard, isCourse }: Props) {
  const router = useRouter();
  const [state, setState]   = useState<Exclude<BuildState, "ready">>(initialState);
  const [error, setError]   = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const building = state === "building";
  const rebuildable = canRebuild(state, isCourse);

  // While a build is in flight, the same watcher the first build uses: the
  // page refreshes itself the moment the track lands, so nobody has to guess
  // when to press refresh.
  useTrackStatusWatch({
    goalId,
    active:   building,
    onReady:  () => router.refresh(),
    onFailed: () => setState("failed"),
  });

  async function handleRetry() {
    setAsking(true);
    setError(null);
    try {
      const res  = await fetch(`/api/dashboard/goals/${goalId}/retry`, { method: "POST" });
      const data = (await res.json()) as { error?: string };

      if (!res.ok) {
        setError(data.error ?? "Could not start the rebuild. Try again in a moment.");
        return;
      }
      setState("building");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      {building ? (
        <>
          <Loader2 size={22} className="animate-spin text-sky-400" />
          <p className="text-base font-semibold text-slate-300">Building your track</p>
          <p className="max-w-xs text-sm leading-relaxed text-slate-500">
            Hugh is drawing up your milestones. This usually takes under a
            minute — the board opens on its own when it is ready.
          </p>
        </>
      ) : (
        <>
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-base font-semibold text-slate-300">
            {emptyBoard ? "This track has no milestones" : "Track build failed"}
          </p>
          <p className="max-w-sm text-sm leading-relaxed text-slate-500">
            {!isCourse
              ? EARLIER_TOPIC_NO_REBUILD
              : emptyBoard
              ? "The track was created but its milestones were never saved. Rebuilding will draw up a fresh set."
              : state === "stalled"
              ? "The build stopped partway through and never finished. Your goal is safe — rebuilding starts it again."
              : "Hugh could not draw up your milestones. Your goal is safe — rebuilding starts it again."}
          </p>

          {error && (
            <p className="max-w-sm text-xs leading-relaxed text-red-400/90" role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            {rebuildable ? (
              <button
                onClick={handleRetry}
                disabled={asking}
                className="flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {asking ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                {asking ? "Starting…" : "Rebuild track"}
              </button>
            ) : !isCourse ? (
              <Link
                href={CHOOSE_COURSE_HREF}
                className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500"
              >
                {CHOOSE_COURSE_LABEL}
              </Link>
            ) : null}
            <Link
              href="/home/learn"
              className="flex items-center gap-1.5 rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-200"
            >
              <ArrowLeft size={14} />
              Your goals
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
