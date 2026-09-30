"use client";

import { useEffect, useState } from "react";
import { ListChecks, Loader2, ArrowLeftToLine, X } from "lucide-react";
import { type CoverageResponse, type LearningPoint, type PointStatus } from "@/types";
import { normalizeCoverage, countByStatus } from "@/utils/coverage";
import PointStatusControl from "./PointStatusControl";

interface Props {
  milestoneId:      string;
  milestoneTitle:   string;
  mobileOpen:       boolean;
  onClose:          () => void;
  // Drops a point's text into the chat composer (wired up by AskWorkspace), so
  // the learner can ask about an idea without retyping it.
  onInsertToPrompt?: (text: string) => void;
}

/**
 * Persistent side-rail for the Ask page. Shows the focused milestone's
 * enumerated "things to understand". Coverage is a self-assessment: for each
 * idea the learner flags whether they understand it, want to bookmark it for
 * later, or are still stuck — purely their own awareness check. (No AI judges
 * coverage, and none of this gates mastery.)
 */
export default function ChecklistRail({ milestoneId, milestoneTitle, mobileOpen, onClose, onInsertToPrompt }: Props) {
  const [points, setPoints]     = useState<LearningPoint[]>([]);
  const [statuses, setStatuses] = useState<Record<string, PointStatus>>({});
  const [loading, setLoading]   = useState(true);
  // Distinct from "no points": the checklist is built by a model on first open,
  // and a response that could not be trusted is written nowhere. Reporting that
  // as an empty rail would tell the learner this milestone has no key ideas.
  const [failed, setFailed]     = useState(false);
  // Bumped by "Try again" to re-run the effect, since milestoneId cannot change.
  const [attempt, setAttempt]   = useState(0);

  // Load the checklist + saved statuses on open. `loading` starts true and
  // milestoneId is fixed for this component's life, so no in-effect reset needed.
  useEffect(() => {
    let active = true;
    // No synchronous reset here: `loading` starts true, and "Try again" clears
    // the failed state itself before bumping `attempt`, so the effect only ever
    // sets state from its own async result.
    fetch(`/api/tracker/milestones/${milestoneId}/coverage`)
      .then(async r => ({ ok: r.ok, body: await r.json() as CoverageResponse }))
      .then(({ ok, body }) => {
        if (!active) return;
        // The statuses are returned even on the failure path, so a learner who
        // has already ticked things keeps seeing them.
        setStatuses(normalizeCoverage(body.coverage)?.statuses ?? {});
        if (!ok) { setFailed(true); return; }
        setPoints(body.learningPoints ?? []);
      })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [milestoneId, attempt]);

  function setStatus(id: string, next: PointStatus | undefined) {
    const updated = { ...statuses };
    if (next) updated[id] = next; else delete updated[id];
    setStatuses(updated); // optimistic
    void fetch(`/api/tracker/milestones/${milestoneId}/coverage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ statuses: updated }),
    }).catch(() => {});
  }

  const understood = countByStatus(statuses, "understood");
  const bookmarked = countByStatus(statuses, "bookmarked");
  const stuck      = countByStatus(statuses, "stuck");
  const allCovered = points.length > 0 && understood === points.length;

  return (
    <aside className={`${mobileOpen ? "flex" : "hidden"} fixed inset-y-0 right-0 z-40 h-dvh w-full max-w-sm shrink-0 flex-col border-l border-slate-800 bg-slate-900 lg:static lg:z-auto lg:flex lg:h-auto lg:w-72 lg:max-w-none lg:bg-slate-900/50`} aria-label="What to understand">
      {/* Header */}
      <div className="shrink-0 border-b border-slate-800 px-5 py-3.5">
        <div className="flex items-center gap-2">
          <ListChecks size={14} className="text-sky-400" />
          <p className="text-sm font-semibold text-white">What to understand</p>
          <button type="button" onClick={onClose} aria-label="Close checklist" className="ml-auto flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-400 lg:hidden">
            <X size={18} />
          </button>
        </div>
        <p className="mt-0.5 truncate text-xs text-slate-500">{milestoneTitle}</p>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading && points.length === 0 ? (
          <div className="flex items-center gap-2 py-3 text-xs text-slate-500">
            <Loader2 size={12} className="animate-spin" />
            Building your checklist…
          </div>
        ) : failed ? (
          <div className="py-3">
            <p className="text-xs leading-relaxed text-slate-400">
              The checklist for this card could not be built.
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Nothing is wrong with your card — this step just did not come
              back cleanly.
            </p>
            <button
              onClick={() => { setFailed(false); setLoading(true); setAttempt(n => n + 1); }}
              className="mt-2 text-xs font-semibold text-sky-400 transition-colors hover:text-sky-300"
            >
              Try again
            </button>
          </div>
        ) : points.length === 0 ? (
          <p className="py-3 text-xs text-slate-600">
            No checklist available for this card yet.
          </p>
        ) : (
          <ol className="space-y-3">
            {points.map(p => (
              <li key={p.id} className="group flex items-start gap-2">
                {onInsertToPrompt && (
                  <button
                    type="button"
                    onClick={() => onInsertToPrompt(p.text)}
                    title="Ask Hugh about this — drops it into the chat box"
                    aria-label={`Ask about: ${p.text}`}
                    className="mt-0.5 shrink-0 text-slate-600 transition-colors hover:text-sky-400 focus:text-sky-400 focus:outline-none"
                  >
                    <ArrowLeftToLine size={13} />
                  </button>
                )}
                <span className="flex-1 text-sm leading-snug text-slate-400">
                  {p.text}
                </span>
                <PointStatusControl
                  current={statuses[p.id]}
                  onChange={next => setStatus(p.id, next)}
                />
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Footer — progress + guidance */}
      {points.length > 0 && (
        <div className="shrink-0 border-t border-slate-800 px-5 py-3">
          <span className={`text-xs font-medium ${allCovered ? "text-green-400" : "text-slate-500"}`}>
            {allCovered
              ? "All ideas marked understood"
              : `${understood} of ${points.length} understood`}
            {bookmarked > 0 && <span className="text-amber-400"> · {bookmarked} bookmarked</span>}
            {stuck > 0 && <span className="text-red-400"> · {stuck} to revisit</span>}
          </span>
          <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
            Flag each idea as understood, bookmarked for later, or still unclear — your own honest progress check.
          </p>
        </div>
      )}
    </aside>
  );
}
