"use client";

import { useDraggable } from "@dnd-kit/core";
import { GripVertical, BookOpen, OctagonAlert, ChevronRight, ChevronUp, ChevronDown, Check, Bookmark, HelpCircle } from "lucide-react";
import { type Milestone, type BacklogPriorityMode, type KanbanColumn, KANBAN_COLUMNS, KANBAN_COLUMN_LABELS } from "@/types";
import { normalizeCoverage, countByStatus } from "@/utils/coverage";

interface Props {
  milestone:       Milestone;
  entryCount:      number;
  isActive:        boolean;
  isPulsing:       boolean;
  isFocused:       boolean;
  isBacklog?:      boolean;             // backlog cards get arrows in manual mode
  priorityRank?:   number | null;      // Hugh's agentic rank; shown as badge in auto mode
  priorityReason?: string | null;      // one-line tooltip on the rank badge
  priorityMode?:   BacklogPriorityMode;
  canMoveUp?:      boolean;
  canMoveDown?:    boolean;
  onMove?:         (dir: "up" | "down") => void;
  onChangeColumn?: (column: KanbanColumn) => void;
  isOverlay?:      boolean;
  onClick:         (milestone: Milestone) => void;
}

const CARD_TINTS: Record<string, { bg: string; border: string }> = {
  backlog: { bg: "bg-slate-800",      border: "border-slate-700"    },
  learn:   { bg: "bg-sky-950/80",     border: "border-sky-900/60"   },
  review:  { bg: "bg-amber-950/60",   border: "border-amber-900/50" },
  done:    { bg: "bg-green-950/60",   border: "border-green-900/50" },
};

export default function MilestoneCard({
  milestone, entryCount, isActive, isPulsing, isFocused,
  isBacklog, priorityRank, priorityReason, priorityMode, canMoveUp, canMoveDown, onMove,
  isOverlay, onClick, onChangeColumn,
}: Props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id:   milestone.id,
    data: { kanban_column: milestone.kanban_column },
  });

  const tint         = CARD_TINTS[milestone.kanban_column] ?? CARD_TINTS.backlog;
  const needsReview  = milestone.kanban_column === "review" && !milestone.review_validated;
  const needsMastery = milestone.kanban_column === "done"   && !milestone.mastery_validated;
  const showStopSign = needsReview || needsMastery;

  // Auto mode shows Hugh's guidance badge; Manual mode shows reorder arrows.
  // Both are backlog-only concepts — a card keeps its priority_rank after
  // leaving the backlog, so without the isBacklog check it would still show
  // the badge in review/done, stacking on top of the unverified stop sign.
  const showBadge  = priorityMode === "auto"   && priorityRank != null && !!isBacklog;
  const showArrows = priorityMode === "manual" && !!isBacklog;

  // Self-assessment summary surfaced top-right — even in review/done columns the
  // learner can see at a glance which cards carry bookmarks or stuck points.
  // Untouched cards (no statuses set) show nothing.
  const coverage   = normalizeCoverage(milestone.coverage);
  const understood = coverage ? countByStatus(coverage.statuses, "understood") : 0;
  const bookmarked = coverage ? countByStatus(coverage.statuses, "bookmarked") : 0;
  const stuck      = coverage ? countByStatus(coverage.statuses, "stuck") : 0;
  const hasChips   = understood > 0 || bookmarked > 0 || stuck > 0;

  const statusChips = hasChips ? (
    <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
      {understood > 0 && (
        <span className="flex items-center gap-0.5 text-green-400" title={`${understood} understood`}>
          <Check size={11} /><span className="text-xs font-medium">{understood}</span>
        </span>
      )}
      {bookmarked > 0 && (
        <span className="flex items-center gap-0.5 text-amber-400" title={`${bookmarked} bookmarked to revisit`}>
          <Bookmark size={11} /><span className="text-xs font-medium">{bookmarked}</span>
        </span>
      )}
      {stuck > 0 && (
        <span className="flex items-center gap-0.5 text-red-400" title={`${stuck} still unclear`}>
          <HelpCircle size={11} /><span className="text-xs font-medium">{stuck}</span>
        </span>
      )}
    </div>
  ) : null;

  // Overlay: the floating card while dragging
  if (isOverlay) {
    return (
      <div className={`flex flex-col gap-2 rounded-xl border p-4 shadow-2xl shadow-black/60 ring-1 ring-white/10 scale-[1.03] cursor-grabbing select-none
        ${tint.bg} ${tint.border}`}
      >
        {showStopSign && (
          <div className="absolute left-2 top-[13px] glow-red pointer-events-none">
            <OctagonAlert size={13} className="text-red-400" />
          </div>
        )}
        <div className="flex items-start justify-between gap-2">
          <p className={`text-sm font-semibold text-slate-100 leading-snug ${showStopSign ? "pl-5" : ""} ${!hasChips ? "pr-6" : ""}`}>
            {milestone.title}
          </p>
          {statusChips}
        </div>
        <p className="line-clamp-2 text-xs text-slate-400 leading-relaxed">
          {milestone.summary}
        </p>
        {entryCount > 0 && (
          <div className="flex items-center gap-1.5 mt-1">
            <BookOpen size={11} className="text-slate-500" />
            <span className="text-xs text-slate-500">
              {entryCount} {entryCount === 1 ? "entry" : "entries"}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onClick(milestone)}
      className={`group relative flex flex-col gap-2 rounded-xl border p-4 transition-all duration-200 select-none
        ${isDragging
          ? "border-dashed border-slate-600 bg-slate-800/20 opacity-30"
          : isActive
          ? "cursor-pointer border-violet-500/60 bg-slate-800 shadow-[0_0_18px_rgba(139,92,246,0.25)] ring-1 ring-violet-500/30"
          : isPulsing
          ? "cursor-pointer border-violet-400 bg-slate-800 shadow-[0_0_28px_rgba(139,92,246,0.55)] ring-2 ring-violet-400/40"
          : isFocused
          ? "cursor-grab active:cursor-grabbing border-violet-500/50 bg-slate-800/90 shadow-[0_0_16px_rgba(139,92,246,0.22)] ring-1 ring-violet-500/25"
          : `cursor-grab active:cursor-grabbing ${tint.bg} ${tint.border} hover:brightness-110 hover:border-opacity-80`
        }`}
    >
      {/* Unvalidated review indicator — subtle pulsing red stop sign */}
      {showStopSign && !isDragging && (
        <div className="absolute left-2 top-[13px] glow-red pointer-events-none">
          <OctagonAlert size={13} className="text-red-400" />
        </div>
      )}

      {/* Hugh's suggested study-order badge (auto mode only) */}
      {showBadge && !isDragging && (
        <div
          title={priorityReason ?? undefined}
          className="absolute left-2 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-sky-500/15 text-[10px] font-bold text-sky-300 cursor-help"
        >
          {priorityRank}
        </div>
      )}

      {/* Grip handle — yields the corner to the status summary when present */}
      {!isDragging && !hasChips && (
        <div className="absolute right-2 top-2 text-slate-600 opacity-30 group-hover:opacity-70 transition-opacity pointer-events-none">
          <GripVertical size={14} />
        </div>
      )}

      <div className="flex items-start justify-between gap-2">
        <p className={`text-sm font-semibold text-slate-100 leading-snug ${showBadge ? "pl-7" : showStopSign ? "pl-5" : ""} ${!hasChips ? "pr-6" : ""}`}>
          {milestone.title}
        </p>
        {statusChips}
      </div>

      <p className="line-clamp-2 text-xs text-slate-400 leading-relaxed">
        {milestone.summary}
      </p>

      <div className="flex items-center justify-between mt-1">
        <div className="flex items-center gap-1.5">
          {/* Manual reorder arrows (backlog, manual mode only) */}
          {showArrows && !isDragging && (
            <div className="flex items-center gap-0.5">
              <button
                onClick={e => { e.stopPropagation(); onMove?.("up"); }}
                onPointerDown={e => e.stopPropagation()}
                disabled={!canMoveUp}
                title="Move up"
                className="rounded p-0.5 text-slate-500 hover:text-sky-300 hover:bg-slate-700/60 disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-slate-500 transition-colors"
              >
                <ChevronUp size={13} />
              </button>
              <button
                onClick={e => { e.stopPropagation(); onMove?.("down"); }}
                onPointerDown={e => e.stopPropagation()}
                disabled={!canMoveDown}
                title="Move down"
                className="rounded p-0.5 text-slate-500 hover:text-sky-300 hover:bg-slate-700/60 disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-slate-500 transition-colors"
              >
                <ChevronDown size={13} />
              </button>
            </div>
          )}
          {entryCount > 0 && (
            <div className="flex items-center gap-1.5">
              <BookOpen size={11} className="text-slate-500" />
              <span className="text-xs text-slate-500">
                {entryCount} {entryCount === 1 ? "entry" : "entries"}
              </span>
            </div>
          )}
        </div>
        <span className="flex items-center gap-0.5 text-xs text-slate-400 cursor-pointer hover:text-slate-100 transition-colors select-none">
          See details
          <ChevronRight size={11} />
        </span>
      </div>
      {onChangeColumn && (
        <select
          aria-label={`Move ${milestone.title} to column`}
          value={milestone.kanban_column}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onChange={event => { event.stopPropagation(); onChangeColumn(event.target.value as KanbanColumn); }}
          className="min-h-11 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-200 md:hidden"
        >
          {KANBAN_COLUMNS.map(column => (
            <option key={column} value={column}>Move to {KANBAN_COLUMN_LABELS[column]}</option>
          ))}
        </select>
      )}
    </div>
  );
}
