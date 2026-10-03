"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Trophy, Medal, Crown } from "lucide-react";
import {
  outcomeOfStatus, outcomeOfThrown,
  type SaveOutcome, type SaveFailure,
} from "@/lib/errors/saveOutcome";
import { type Milestone, type KanbanColumn, type BacklogPriorityMode, KANBAN_COLUMNS } from "@/types";
import KanbanColumnComponent from "./KanbanColumn";
import MilestoneCard from "./MilestoneCard";
import MilestoneDrawer from "./MilestoneDrawer";
import SaveFailureNotice from "@/components/ui/SaveFailureNotice";

interface Props {
  initialMilestones: Milestone[];
  goalId:            string;   // required — see MilestoneDrawer's Props
  trackId?:          string;
  focusMilestoneId?: string | null;
  backlogPriorityMode?: BacklogPriorityMode;
  pulseId?:          string;
  validatedId?:      string;
  masteredId?:       string;
  isPremium?:        boolean;
  isAdmin?:          boolean;
  liveAvailable?:    boolean;
}

export default function KanbanBoard({
  initialMilestones, goalId, trackId, focusMilestoneId,
  backlogPriorityMode = "auto",
  pulseId: initialPulseId, validatedId, masteredId,
  isPremium = false, isAdmin = false, liveAvailable = false,
}: Props) {
  const router   = useRouter();
  const pathname = usePathname();

  const [milestones, setMilestones]               = useState<Milestone[]>(initialMilestones);
  const [activeMilestone, setActiveMilestone]     = useState<Milestone | null>(null);
  const [draggingMilestone, setDraggingMilestone] = useState<Milestone | null>(null);
  const [entryCounts, setEntryCounts]             = useState<Record<string, number>>({});
  const [pulseId, setPulseId]                     = useState<string | null>(initialPulseId ?? null);
  const [focusId, setFocusId]                     = useState<string | null>(focusMilestoneId ?? null);
  const [priorityMode, setPriorityMode]           = useState<BacklogPriorityMode>(backlogPriorityMode);
  const [showPremiumGate, setShowPremiumGate]     = useState(false);

  // Set when an optimistic change was rolled back because the save was refused.
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);

  // Celebration state
  const [toastVisible, setToastVisible] = useState(false);
  const [toastTitle,   setToastTitle]   = useState("");
  const [toastKind,    setToastKind]    = useState<"review" | "mastery">("review");

  // These two effects fire a one-time celebration based on a navigation result;
  // the setState calls are the whole point, so suppress the setState-in-effect rule.
  /* eslint-disable react-hooks/set-state-in-effect */
  // Confetti + toast when returning from a passed quiz (review)
  useEffect(() => {
    if (!validatedId) return;
    const ms = milestones.find(m => m.id === validatedId);
    setToastTitle(ms?.title ?? "");
    setToastKind("review");
    setToastVisible(true);
    import("canvas-confetti").then(({ default: confetti }) => {
      confetti({ particleCount: 110, spread: 70, origin: { y: 0.65 }, colors: ["#10b981", "#3b82f6", "#8b5cf6", "#f59e0b", "#ffffff"] });
      setTimeout(() => {
        confetti({ particleCount: 60, spread: 90, origin: { y: 0.55 }, colors: ["#10b981", "#3b82f6", "#8b5cf6", "#f59e0b"] });
      }, 200);
    });
    router.replace(pathname, { scroll: false });
    const t = setTimeout(() => setToastVisible(false), 5000);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Bigger gold confetti + toast when returning from a passed mastery session
  useEffect(() => {
    if (!masteredId) return;
    const ms = milestones.find(m => m.id === masteredId);
    setToastTitle(ms?.title ?? "");
    setToastKind("mastery");
    setToastVisible(true);
    import("canvas-confetti").then(({ default: confetti }) => {
      const gold = ["#f59e0b", "#fcd34d", "#fbbf24", "#ffffff", "#10b981"];
      confetti({ angle: 60,  spread: 55, particleCount: 100, origin: { x: 0, y: 0.7 }, colors: gold });
      confetti({ angle: 120, spread: 55, particleCount: 100, origin: { x: 1, y: 0.7 }, colors: gold });
      setTimeout(() => {
        confetti({ particleCount: 80, spread: 100, origin: { y: 0.45 }, colors: gold });
      }, 350);
    });
    router.replace(pathname, { scroll: false });
    const t = setTimeout(() => setToastVisible(false), 6000);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!pulseId) return;
    const t = setTimeout(() => setPulseId(null), 5000);
    return () => clearTimeout(t);
  }, [pulseId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  function handleDragStart({ active }: DragStartEvent) {
    const ms = milestones.find(m => m.id === active.id);
    setDraggingMilestone(ms ?? null);
  }

  /**
   * Send an optimistic change, and undo it on screen if the server refused.
   *
   * A dragged card is applied locally before the request so the board feels
   * immediate. The undo used to hang off `.catch()` — but that only fires when
   * the request never reached a server at all. A 401 or a 500 *resolves*, so
   * the card sat happily in its new column while the database kept the old one,
   * and the move quietly evaporated on the next page load. Reading the status
   * is what makes the rollback fire for the failures that actually happen.
   */
  async function persistOrRollBack(url: string, body: object, rollBack: () => void) {
    let outcome: SaveOutcome;
    try {
      const res = await fetch(url, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      outcome = outcomeOfStatus(res.status);
    } catch (err) {
      outcome = outcomeOfThrown(err);
    }

    if (outcome.ok) return;

    rollBack();
    setToastVisible(false); // never leave a celebration up beside a failure
    setSaveFailure(outcome);
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setDraggingMilestone(null);
    if (!over) return;

    const milestoneId = active.id as string;
    const newColumn   = over.id as KanbanColumn;
    const current     = milestones.find(m => m.id === milestoneId);
    if (!current || current.kanban_column === newColumn) return;

    // Non-premium users can't drag to Mastered
    if (newColumn === "done" && !isPremium && !isAdmin) {
      setShowPremiumGate(true);
      return;
    }

    const updatedFields: Partial<Milestone> = { kanban_column: newColumn };
    if (newColumn === "review") updatedFields.review_validated  = false;
    if (newColumn === "done")   updatedFields.mastery_validated = false;

    setMilestones(prev =>
      prev.map(m => m.id === milestoneId ? { ...m, ...updatedFields } : m)
    );

    const patchBody: { column: KanbanColumn; reviewValidated?: boolean } = { column: newColumn };
    if (newColumn === "review") patchBody.reviewValidated  = false;

    void persistOrRollBack(
      `/api/tracker/milestones/${milestoneId}`,
      patchBody,
      () => setMilestones(prev =>
        prev.map(m => m.id === milestoneId ? { ...m, ...current } : m)
      ),
    );
  }

  function handleDragCancel() {
    setDraggingMilestone(null);
  }

  const handleCardClick = useCallback((milestone: Milestone) => {
    setActiveMilestone(milestone);
    // Opening a card makes it the persistent focus — glows until another is picked.
    setFocusId(prev => {
      if (prev === milestone.id) return prev;
      if (trackId) {
        fetch(`/api/tracker/tracks/${trackId}`, {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ focusMilestoneId: milestone.id }),
        }).catch(() => {});
      }
      return milestone.id;
    });
  }, [trackId]);

  function toggleMode(mode: BacklogPriorityMode) {
    setPriorityMode(prev => {
      if (prev === mode) return prev;
      if (trackId) {
        fetch(`/api/tracker/tracks/${trackId}`, {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ backlogPriorityMode: mode }),
        }).catch(() => {});
      }
      return mode;
    });
  }

  // Manual reorder: swap a backlog card with its neighbour and persist.
  function moveCard(milestoneId: string, dir: "up" | "down") {
    const backlog = milestones
      .filter(m => m.kanban_column === "backlog")
      .sort((a, b) => a.position - b.position);

    const idx    = backlog.findIndex(m => m.id === milestoneId);
    const target = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || target < 0 || target >= backlog.length) return;

    const a = backlog[idx];
    const b = backlog[target];

    // Optimistic: swap their position values
    setMilestones(prev => prev.map(m =>
      m.id === a.id ? { ...m, position: b.position }
      : m.id === b.id ? { ...m, position: a.position }
      : m
    ));

    const newOrder = [...backlog];
    [newOrder[idx], newOrder[target]] = [newOrder[target], newOrder[idx]];
    const orderedIds = newOrder.map(m => m.id);

    if (trackId) {
      void persistOrRollBack(
        `/api/tracker/tracks/${trackId}/reorder`,
        { orderedIds },
        // Revert on failure
        () => setMilestones(prev => prev.map(m =>
          m.id === a.id ? { ...m, position: a.position }
          : m.id === b.id ? { ...m, position: b.position }
          : m
        )),
      );
    }
  }

  // Keep the board's milestone copy in sync when the drawer changes a card's
  // self-assessment statuses, so the card's top-right chips update instantly.
  const handleCoverageChange = useCallback((milestoneId: string, coverage: Milestone["coverage"]) => {
    setMilestones(prev => prev.map(m => m.id === milestoneId ? { ...m, coverage } : m));
  }, []);

  function handleDrawerClose() {
    if (activeMilestone) {
      // Only a reply we actually read may change the badge. A refusal answers
      // `{ error }`, and `(d.entries ?? []).length` turned that into a confident
      // zero — so a card reading "3 entries" quietly lost its badge because a
      // request failed. Keeping the previous count is the honest move here: the
      // card has no room to explain itself, and a stale count is a smaller lie
      // than an invented one. The panel that just closed is where a failed read
      // gets said out loud.
      const milestoneId = activeMilestone.id;
      fetch(`/api/tracker/milestones/${milestoneId}/entries`)
        .then(async res => {
          if (!res.ok) return;
          const body    = await res.json() as { entries?: unknown[] };
          const entries = body.entries;
          if (!entries) return;
          setEntryCounts(prev => ({ ...prev, [milestoneId]: entries.length }));
        })
        .catch(() => {});
    }
    setActiveMilestone(null);
  }

  const byColumn = KANBAN_COLUMNS.reduce<Record<KanbanColumn, Milestone[]>>(
    (acc, col) => {
      const cards = milestones.filter(m => m.kanban_column === col);
      // Auto mode orders the backlog by Hugh's agentic rank (nulls last, then position).
      // Everything else (manual backlog + all other columns) orders by position.
      acc[col] = col === "backlog" && priorityMode === "auto"
        ? cards.sort((a, b) =>
            (a.priority_rank ?? Number.MAX_SAFE_INTEGER) - (b.priority_rank ?? Number.MAX_SAFE_INTEGER)
            || a.position - b.position)
        : cards.sort((a, b) => a.position - b.position);
      return acc;
    },
    { backlog: [], learn: [], review: [], done: [] }
  );

  return (
    <div className="relative h-full">
      {/* Subtle background orbs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-breathe absolute -top-1/3 right-1/4 h-[600px] w-[600px] rounded-full bg-sky-500/[0.06] blur-3xl" />
        <div className="animate-breathe-delayed absolute -bottom-1/3 left-1/5 h-[700px] w-[700px] rounded-full bg-violet-500/[0.05] blur-3xl" />
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="relative z-10 flex flex-col h-full gap-2">
          <div className="flex gap-4 flex-1 min-h-0">
            {KANBAN_COLUMNS.map(col => (
              <KanbanColumnComponent
                key={col}
                column={col}
                milestones={byColumn[col]}
                entryCounts={entryCounts}
                activeId={activeMilestone?.id ?? null}
                pulseId={pulseId}
                focusId={focusId}
                isDragging={!!draggingMilestone}
                priorityMode={priorityMode}
                onToggleMode={toggleMode}
                onMoveCard={moveCard}
                onCardClick={handleCardClick}
              />
            ))}
          </div>

          <p className={`text-center text-xs text-slate-600 transition-opacity duration-200 ${draggingMilestone ? "opacity-100" : "opacity-0"}`}>
            Drop on any column — cards can move forward or backward
          </p>
        </div>

        <DragOverlay dropAnimation={{ duration: 180, easing: "ease" }}>
          {draggingMilestone && (
            <MilestoneCard
              milestone={draggingMilestone}
              entryCount={entryCounts[draggingMilestone.id] ?? 0}
              isActive={false}
              isPulsing={false}
              isFocused={false}
              isOverlay
              onClick={() => {}}
            />
          )}
        </DragOverlay>
      </DndContext>

      <MilestoneDrawer
        milestone={activeMilestone}
        goalId={goalId}
        onClose={handleDrawerClose}
        onCoverageChange={handleCoverageChange}
        liveAvailable={liveAvailable}
      />

      {/* ── Premium gate modal ─────────────────────────────────────────── */}
      {showPremiumGate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowPremiumGate(false)}
        >
          <div
            className="w-full max-w-sm mx-4 rounded-3xl border border-amber-500/30 bg-[#1c1200] p-6 space-y-4 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/20">
                <Crown size={18} className="text-amber-400" />
              </div>
              <div>
                <p className="font-semibold text-white">Hugh Pro feature</p>
                <p className="text-xs text-amber-600/80">Mastery Sessions</p>
              </div>
            </div>

            <p className="text-sm text-slate-400 leading-relaxed">
              Moving a card to <span className="text-amber-300 font-medium">Mastered</span> is a Pro feature. Live voice sessions are being prepared for paying learners.
            </p>

            <Link
              href="/upgrade"
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-500 py-3 text-sm font-bold text-black hover:bg-amber-400 transition-colors"
            >
              <Crown size={14} />
              See Hugh Pro
            </Link>

            <button
              onClick={() => setShowPremiumGate(false)}
              className="w-full text-center text-xs text-slate-600 hover:text-slate-400 transition-colors py-1"
            >
              Maybe later
            </button>
          </div>
        </div>
      )}

      {/* ── Save-refused notice ───────────────────────────────────────────
          Sits where the celebration sits, and stays until dismissed. A move
          that silently snapped back is the thing a learner is most likely to
          miss, so this one does not time itself out. */}
      {saveFailure && (
        <div className="fixed bottom-8 left-1/2 z-50 animate-toast-in">
          <SaveFailureNotice
            failure={saveFailure}
            title="Card moved back"
            onDismiss={() => setSaveFailure(null)}
          />
        </div>
      )}

      {/* ── Celebration toast ─────────────────────────────────────────── */}
      {toastVisible && (
        <div className="fixed bottom-8 left-1/2 z-50 animate-toast-in">
          {toastKind === "mastery" ? (
            <div className="flex items-center gap-3 rounded-2xl border border-amber-500/50 bg-[#1a1000] px-5 py-4 shadow-2xl shadow-black/60 backdrop-blur-sm">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/20">
                <Medal size={18} className="text-amber-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-amber-300">Mastered!</p>
                {toastTitle && (
                  <p className="mt-0.5 max-w-[220px] truncate text-xs text-amber-500/70">{toastTitle}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-2xl border border-green-500/40 bg-[#0a1a12] px-5 py-4 shadow-2xl shadow-black/60 backdrop-blur-sm">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-green-500/20">
                <Trophy size={18} className="text-green-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-green-300">Card Validated!</p>
                {toastTitle && (
                  <p className="mt-0.5 max-w-[220px] truncate text-xs text-green-500/70">{toastTitle}</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
