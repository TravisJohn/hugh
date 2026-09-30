"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  type KanbanColumn as KanbanColumnType, type Milestone,
  type BacklogPriorityMode, KANBAN_COLUMN_LABELS,
} from "@/types";
import MilestoneCard from "./MilestoneCard";

const COLUMN_STYLES: Record<KanbanColumnType, {
  dot:    string;
  header: string;
  ring:   string;   // shown on drag-over only
}> = {
  backlog: { dot: "bg-slate-500", header: "text-slate-400", ring: "ring-slate-600"  },
  learn:   { dot: "bg-sky-500",   header: "text-sky-400",   ring: "ring-sky-700"    },
  review:  { dot: "bg-amber-500", header: "text-amber-400", ring: "ring-amber-700"  },
  done:    { dot: "bg-green-500", header: "text-green-400", ring: "ring-green-700"  },
};

interface Props {
  column:        KanbanColumnType;
  milestones:    Milestone[];
  entryCounts:   Record<string, number>;
  activeId:      string | null;
  pulseId:       string | null;
  focusId:       string | null;
  isDragging:    boolean;
  priorityMode:  BacklogPriorityMode;
  mobileActive:  boolean;
  onToggleMode:  (mode: BacklogPriorityMode) => void;
  onMoveCard:    (milestoneId: string, dir: "up" | "down") => void;
  onChangeColumn: (milestoneId: string, column: KanbanColumnType) => void;
  onCardClick:   (milestone: Milestone) => void;
}

export default function KanbanColumn({
  column, milestones, entryCounts, activeId, pulseId, focusId, isDragging,
  priorityMode, mobileActive, onToggleMode, onMoveCard, onChangeColumn, onCardClick,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: column });
  const styles    = COLUMN_STYLES[column];
  const isBacklog = column === "backlog";

  return (
    <div className={`${mobileActive ? "flex" : "hidden"} min-w-0 flex-1 flex-col h-full md:flex`}>
      {/* Column header */}
      <div className="mb-3 flex items-center gap-2 px-1">
        <span className={`h-2 w-2 rounded-full ${styles.dot}`} />
        <span className={`min-w-0 truncate text-xs font-bold uppercase tracking-widest ${styles.header}`}>
          {KANBAN_COLUMN_LABELS[column]}
        </span>
        {isBacklog ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Priority
            </span>
            <div className="flex items-center rounded-lg border border-slate-700 bg-slate-800/60 p-0.5 text-[10px] font-semibold">
              <button
                onClick={() => onToggleMode("auto")}
                title="Auto: Hugh orders the backlog by suggested priority"
                className={`rounded-md px-1.5 py-0.5 capitalize transition-colors ${
                  priorityMode === "auto" ? "bg-sky-500/20 text-sky-300" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                auto
              </button>
              <button
                onClick={() => onToggleMode("manual")}
                title="Manual: you control the order with the arrows"
                className={`rounded-md px-1.5 py-0.5 capitalize transition-colors ${
                  priorityMode === "manual" ? "bg-sky-500/20 text-sky-300" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                manual
              </button>
            </div>
            <span className="text-xs text-slate-600 font-mono">{milestones.length}</span>
          </div>
        ) : (
          <span className="ml-auto text-xs text-slate-600 font-mono">{milestones.length}</span>
        )}
      </div>

      {/* Drop zone */}
      <div
        ref={setNodeRef}
        className={`flex flex-1 flex-col gap-3 rounded-xl p-3 min-h-[200px] overflow-y-auto transition-all duration-150
          ${isOver
            ? `bg-slate-800/50 ring-2 ${styles.ring}`
            : isDragging
            ? "bg-slate-800/20 ring-1 ring-slate-700/50"
            : "bg-slate-800/20"
          }`}
      >
        {milestones.map((m, idx) => (
          <MilestoneCard
            key={m.id}
            milestone={m}
            entryCount={entryCounts[m.id] ?? 0}
            isActive={m.id === activeId}
            isPulsing={m.id === pulseId}
            isFocused={m.id === focusId}
            isBacklog={isBacklog}
            priorityRank={m.priority_rank}
            priorityReason={m.priority_reason}
            priorityMode={priorityMode}
            canMoveUp={idx > 0}
            canMoveDown={idx < milestones.length - 1}
            onMove={dir => onMoveCard(m.id, dir)}
            onChangeColumn={next => onChangeColumn(m.id, next)}
            onClick={onCardClick}
          />
        ))}

        {milestones.length === 0 && (
          <div className="flex flex-1 items-center justify-center">
            <p className={`text-xs transition-colors duration-150 ${isOver ? styles.header : "text-slate-700"}`}>
              {isOver ? "Release to move here" : "Drop here"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
