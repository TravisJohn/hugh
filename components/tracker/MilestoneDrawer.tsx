"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  X, Plus, Loader2, MessageCircle, ArrowRight,
  Maximize2, Minimize2, ChevronDown, PenLine, BookOpen,
  OctagonAlert, CheckCircle2, ClipboardCheck, Mic,
  ListChecks, Check, Pencil, RotateCw, AlertTriangle, Paperclip,
  Download, FileText, Sparkles, Tag, Archive,
} from "lucide-react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { summaryMarkdownComponents, downloadMarkdown } from "@/lib/tracker/summaryMarkdown";
import {
  type Milestone, type MilestoneEntry, type LearningPoint, type PointStatus,
  type MilestoneCoverage, type CoverageResponse, KANBAN_COLUMN_LABELS,
} from "@/types";
import { normalizeCoverage, countByStatus } from "@/utils/coverage";
import {
  outcomeOfStatus, outcomeOfThrown, withServerMessage, type SaveFailure,
} from "@/lib/errors/saveOutcome";
import { diaryState, canStartFromDiary } from "@/lib/tracker/diaryState";
import PointStatusControl from "@/components/learn/PointStatusControl";
import PointTagSelect from "@/components/learn/PointTagSelect";
import SaveFailureNotice from "@/components/ui/SaveFailureNotice";

interface Props {
  milestone:        Milestone | null;
  // Required, not optional. A milestone always belongs to a track, and the only
  // page that renders this board finds that track BY its goal — so a drawer
  // without a goal was never a state the app could reach. Typing it as optional
  // is what made `/learn` look like a live fallback rather than dead code.
  goalId:           string;
  onClose:          () => void;
  // Lets the parent board keep its milestone copy (and thus the card chips) in
  // sync as the learner changes self-assessment statuses, without a reload.
  onCoverageChange?: (milestoneId: string, coverage: MilestoneCoverage) => void;
  liveAvailable?:   boolean;
}

/**
 * The summary route is this panel's exception to the copy rule. Its neighbours
 * refuse with log shorthand ("Unauthorized", "Not found"), but these three are
 * reasons written to be read — "Add a diary entry before generating a summary"
 * (422), "Milestone is not mastered" (409), "Summary is too long" (413) — and
 * each is more use to a learner than our generic refusal line. Listed
 * explicitly rather than inferred from the status, because a 4xx is not in
 * general a promise that the body is worth showing anyone.
 */
const SUMMARY_HUMAN_REFUSALS = [409, 413, 422] as const;

const COLUMN_COLOURS: Record<string, string> = {
  backlog: "text-slate-400 bg-slate-800",
  learn:   "text-sky-400 bg-sky-900/40",
  review:  "text-amber-400 bg-amber-900/40",
  done:    "text-green-400 bg-green-900/40",
};

function fmtCompact(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-GB", {
    day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
}

interface SectionProps {
  label:    string;
  icon?:    React.ReactNode;
  open:     boolean;
  onToggle: () => void;
  count?:   number;
}

function SectionToggle({ label, icon, open, onToggle, count }: SectionProps) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-2 py-3 text-left"
    >
      <ChevronDown
        size={13}
        className={`shrink-0 text-slate-500 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
      />
      {icon && <span className="shrink-0 text-slate-500">{icon}</span>}
      <span className="flex-1 text-xs font-semibold uppercase tracking-widest text-slate-500">
        {label}
      </span>
      {count !== undefined && (
        <span className="rounded-full bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-600">
          {count}
        </span>
      )}
    </button>
  );
}

export default function MilestoneDrawer({ milestone, goalId, onClose, onCoverageChange, liveAvailable = false }: Props) {
  const pathname = usePathname();

  const [entries, setEntries]               = useState<MilestoneEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  // Set when the diary could not be read. Kept apart from `entries` because
  // an empty list is the one thing it must never be confused with.
  const [entriesFailed, setEntriesFailed]   = useState(false);
  const [draft, setDraft]                   = useState("");
  const [draftTitle, setDraftTitle]         = useState("");
  const [draftPointId, setDraftPointId]     = useState<string | null>(null);
  const [saving, setSaving]                 = useState(false);
  const [expanded, setExpanded]             = useState(false);

  // When set, the diary shows only entries tagged to this learning point.
  const [filterPointId, setFilterPointId]   = useState<string | null>(null);

  // Fact-check / editing state
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId]       = useState<string | null>(null);
  const [editBody, setEditBody]         = useState("");
  const [editTitle, setEditTitle]       = useState("");

  // "What to understand" checklist + coverage
  const [points, setPoints]                   = useState<LearningPoint[]>([]);
  const [statuses, setStatuses]               = useState<Record<string, PointStatus>>({});
  const [loadingCoverage, setLoadingCoverage] = useState(false);
  // "Could not build it" is not "there is nothing to build" — the checklist is
  // generated by a model on first open, and an untrusted response is written
  // nowhere. Kept separate so the drawer can say which happened.
  const [coverageFailed, setCoverageFailed]   = useState(false);
  const [nudgeDismissed, setNudgeDismissed]   = useState(false);

  // Mastery "what you learned" summary document
  const [summaryDoc, setSummaryDoc]   = useState<string | null>(null);
  const [summaryAt, setSummaryAt]     = useState<string | null>(null);
  const [genSummary, setGenSummary]   = useState(false);
  // Kept out of the panel-wide banner on purpose: this generation also runs
  // automatically when a mastered card is opened, and a red toast for
  // something the learner never pressed reads as an app-level alarm. It
  // belongs where the button is, like the checklist failure above it.
  const [summaryFailure, setSummaryFailure] = useState<SaveFailure | null>(null);
  // The document exists and was paid for, but the database would not keep it.
  // Distinct from `summaryFailure`, which means there is no document at all —
  // "here it is, we couldn't store it" and "we couldn't write it" are different
  // things to be told, and only the first one leaves something worth reading.
  const [summaryUnsaved, setSummaryUnsaved] = useState(false);
  const [savingSummary, setSavingSummary]   = useState(false);
  const [showSummary, setShowSummary] = useState(true);

  // Section visibility
  const [showOverview,  setShowOverview]    = useState(true);
  const [showPoints,    setShowPoints]      = useState(true);
  const [showReview,    setShowReview]      = useState(true);
  const [showMastery,   setShowMastery]     = useState(true);
  const [showActions,   setShowActions]     = useState(true);
  const [showDiary,     setShowDiary]       = useState(true);
  const [showWriteEntry, setShowWriteEntry] = useState(true);
  const [showArchived,  setShowArchived]    = useState(false);

  // Which individual entries are expanded
  const [openEntries, setOpenEntries] = useState<Set<string>>(new Set());

  // Set when a save came back refused. One banner for the panel: only one
  // save is ever in flight from a click, and stacking these would bury the
  // newest failure under an older one the learner has already read.
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);

  const textareaRef   = useRef<HTMLTextAreaElement>(null);
  const entriesEndRef = useRef<HTMLDivElement>(null);

  /**
   * Load the diary, and be honest about a load that did not happen.
   *
   * `fetch` resolves for a 401 or a 500 exactly as it does for a 200, so the
   * previous `.then(r => r.json()).then(d => setEntries(d.entries ?? []))`
   * rendered a refusal as a diary with nothing in it. Lifted out of the
   * open-card effect so the failure has a way out: rule 5 asks for a retry that
   * reuses the machine, not advice to close the card and open it again.
   */
  const loadEntries = useCallback(async (milestoneId: string) => {
    setLoadingEntries(true);
    setEntriesFailed(false);
    try {
      const res = await fetch(`/api/tracker/milestones/${milestoneId}/entries`);
      if (!res.ok) { setEntriesFailed(true); return; }
      const body = await res.json() as { entries?: MilestoneEntry[] };
      setEntries(body.entries ?? []);
    } catch {
      setEntriesFailed(true);
    } finally {
      setLoadingEntries(false);
    }
  }, []);

  /**
   * Send a change and read the reply before believing it.
   *
   * Every save on this panel had the same shape — `await fetch(...)`, then
   * `if (d.entry) …` — which does nothing whatsoever when the entry is absent
   * because the save was refused. No message, no spinner, no change on screen:
   * the learner reasonably concludes they misclicked. This returns the refusal
   * instead of discarding it, and leaves each caller to decide where it is
   * shown.
   *
   * `humanRefusals` names the statuses whose message this route wrote for a
   * learner rather than for a log — see `withServerMessage`.
   */
  async function requestSave<T>(
    request:       () => Promise<Response>,
    humanRefusals: readonly number[] = [],
  ): Promise<{ data: T | null; failure: SaveFailure | null }> {
    try {
      const res     = await request();
      const outcome = outcomeOfStatus(res.status);
      if (!outcome.ok) {
        const message = humanRefusals.includes(res.status)
          ? await res.json()
              .then(b => (b as { error?: string }).error)
              .catch(() => undefined)   // a refusal need not carry a JSON body
          : undefined;
        const shown = withServerMessage(outcome, message);
        return { data: null, failure: shown.ok ? null : shown };
      }
      return { data: await res.json() as T, failure: null };
    } catch (err) {
      const outcome = outcomeOfThrown(err);
      return { data: null, failure: outcome.ok ? null : outcome };
    }
  }

  /** `requestSave` for the callers that want the panel-wide banner. */
  async function save<T>(
    request:       () => Promise<Response>,
    humanRefusals: readonly number[] = [],
  ): Promise<T | null> {
    const { data, failure } = await requestSave<T>(request, humanRefusals);
    setSaveFailure(failure);
    return data;
  }

  // Reset all per-milestone state when the open card changes — an intentional
  // sync-on-id pattern, so the setState-in-effect rule is suppressed here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!milestone) {
      setExpanded(false);
      return;
    }
    const isReview  = milestone.kanban_column === "review";
    const isMastery = milestone.kanban_column === "done";
    setDraft("");
    setDraftTitle("");
    setDraftPointId(null);
    setFilterPointId(null);
    setEntries([]);
    setOpenEntries(new Set());
    setEditingId(null);
    setVerifyingIds(new Set());
    setPoints([]);
    setStatuses({});
    setNudgeDismissed(false);
    setSummaryDoc(milestone.summary_doc ?? null);
    setSummaryAt(milestone.summary_doc_at ?? null);
    setGenSummary(false);
    setShowSummary(true);
    setShowOverview(true);
    setShowPoints(true);
    setShowReview(true);
    setShowMastery(true);
    // Collapse support sections in review/mastery mode so the learner focuses on the task
    setShowActions(!isReview && !isMastery);
    setShowDiary(!isReview && !isMastery);
    setShowWriteEntry(!isReview && !isMastery);

    setSaveFailure(null);
    setSummaryFailure(null);
    setSummaryUnsaved(false);
    void loadEntries(milestone.id);

    // Load the checklist + cached coverage (generates the checklist once if absent)
    setLoadingCoverage(true);
    setCoverageFailed(false);
    fetch(`/api/tracker/milestones/${milestone.id}/coverage`)
      .then(async r => ({ ok: r.ok, body: await r.json() as CoverageResponse }))
      .then(({ ok, body }) => {
        // Statuses come back on the failure path too, so a learner who has
        // already ticked things does not watch them vanish.
        setStatuses(normalizeCoverage(body.coverage)?.statuses ?? {});
        if (!ok) { setCoverageFailed(true); return; }
        setPoints(body.learningPoints ?? []);
      })
      .catch(() => setCoverageFailed(true))
      .finally(() => setLoadingCoverage(false));
  }, [milestone?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    entriesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  // Auto-generate the learning summary the first time a mastered card is opened
  // without one yet — so it appears (with a "writing…" state) right after the
  // learner confirms mastery, without blocking the mastery flow itself.
  // Reads the milestone prop (not state) so it never races the reset effect;
  // the setTimeout defers setState out of the effect body.
  useEffect(() => {
    if (!milestone) return;
    if (milestone.kanban_column !== "done") return;
    if (!milestone.mastery_validated) return;
    if (milestone.summary_doc) return;
    const t = setTimeout(() => { void generateSummary(); }, 0);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [milestone?.id]);

  function toggleEntry(id: string) {
    setOpenEntries(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function replaceEntry(updated: MilestoneEntry) {
    setEntries(prev => prev.map(e => e.id === updated.id ? updated : e));
  }

  // Soft-archive: hide from the diary but keep the row (restorable). Optimistic —
  // the active/archived lists derive from `archived_at`, so flipping it locally
  // moves the entry; we reconcile with the server row and revert on failure.
  function setArchived(entryId: string, archived: boolean) {
    const prevArchivedAt = entries.find(e => e.id === entryId)?.archived_at ?? null;
    const optimistic = archived ? new Date().toISOString() : null;
    setEntries(prev => prev.map(e => e.id === entryId ? { ...e, archived_at: optimistic } : e));
    if (archived) setOpenEntries(prev => { const n = new Set(prev); n.delete(entryId); return n; });
    void requestSave<{ entry?: MilestoneEntry }>(() =>
      fetch(`/api/tracker/entries/${entryId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: archived ? "archive" : "restore" }),
      }),
    ).then(({ data, failure }) => {
      if (failure) {
        // Revert to the entry's prior archive state, and say why it moved back.
        // The revert alone was visible but unexplained: an entry that hops out
        // of the archive on its own looks like a bug in the button.
        setEntries(prev => prev.map(e => e.id === entryId ? { ...e, archived_at: prevArchivedAt } : e));
        setSaveFailure(failure);
        return;
      }
      if (data?.entry) replaceEntry(data.entry);
    });
  }

  // Background fact-check for a saved/edited entry
  async function verifyEntry(entryId: string) {
    setVerifyingIds(prev => new Set(prev).add(entryId));
    try {
      const res = await fetch(`/api/tracker/entries/${entryId}/verify`, { method: "POST" });
      const d   = await res.json();
      if (d.entry) replaceEntry(d.entry as MilestoneEntry);
    } catch {
      /* leave as pending — non-blocking */
    } finally {
      setVerifyingIds(prev => {
        const next = new Set(prev);
        next.delete(entryId);
        return next;
      });
    }
  }

  async function submitEntry() {
    if (!draft.trim() || !milestone || saving) return;
    setSaving(true);
    try {
      const d = await save<{ entry?: MilestoneEntry }>(() =>
        fetch(`/api/tracker/milestones/${milestone.id}/entries`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ body: draft.trim(), title: draftTitle.trim() || undefined, pointId: draftPointId }),
        }),
      );
      // On a refusal the banner explains it and the draft below is left alone,
      // so the learner's typing is still there to send again.
      if (d?.entry) {
        const newEntry = d.entry;
        setEntries(prev => [...prev, newEntry]);
        setOpenEntries(prev => new Set([...prev, newEntry.id]));
        setDraft("");
        setDraftTitle("");
        setDraftPointId(null);
        setShowDiary(true);
        void verifyEntry(newEntry.id); // auto fact-check in the background
      }
    } finally {
      setSaving(false);
    }
  }

  async function acceptFix(entryId: string) {
    const d = await save<{ entry?: MilestoneEntry }>(() =>
      fetch(`/api/tracker/entries/${entryId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "accept" }),
      }),
    );
    if (d?.entry) replaceEntry(d.entry);
  }

  function startEdit(entry: MilestoneEntry) {
    setEditingId(entry.id);
    setEditBody(entry.body);
    setEditTitle(entry.title ?? "");
    setOpenEntries(prev => new Set(prev).add(entry.id));
  }

  async function saveEdit(entryId: string) {
    if (!editBody.trim()) return;
    const d = await save<{ entry?: MilestoneEntry }>(() =>
      fetch(`/api/tracker/entries/${entryId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ body: editBody.trim(), title: editTitle.trim() || undefined }),
      }),
    );
    // The editor stays open on a refusal — closing it would strand the rewrite
    // the learner just typed behind an entry still showing the old text.
    if (d?.entry) {
      replaceEntry(d.entry);
      setEditingId(null);
      void verifyEntry(entryId); // re-check the rewritten entry
    }
  }

  // Re-tag an existing entry to a learning point (or clear the tag). No content
  // change, so no re-verify — the server updates point_id only.
  async function retagEntry(entryId: string, pointId: string | null) {
    const d = await save<{ entry?: MilestoneEntry }>(() =>
      fetch(`/api/tracker/entries/${entryId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ pointId }),
      }),
    );
    if (d?.entry) replaceEntry(d.entry);
  }

  // Self-assessment: the learner flags each idea as understood / bookmarked /
  // stuck. Clearing a status removes the id from the map.
  function setPointStatus(id: string, next: PointStatus | undefined) {
    if (!milestone) return;
    const milestoneId = milestone.id;
    const previous    = statuses;
    const updated     = { ...statuses };
    if (next) updated[id] = next; else delete updated[id];
    setStatuses(updated); // optimistic
    // Bubble the change up so the board's card chips update without a reload.
    onCoverageChange?.(milestoneId, { statuses: updated, updatedAt: new Date().toISOString() });
    void requestSave(() =>
      fetch(`/api/tracker/milestones/${milestoneId}/coverage`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ statuses: updated }),
      }),
    ).then(({ failure }) => {
      if (!failure) return;
      // The worst of the silent saves, because it was optimistic *and*
      // published: a refused tick stayed ticked here and on the card behind the
      // panel, and stayed wrong until a reload. Put both back, and say so.
      // The timestamp is a fresh one — it stamps when this map became true on
      // screen, which it just did, rather than claiming the server's.
      setStatuses(previous);
      onCoverageChange?.(milestoneId, { statuses: previous, updatedAt: new Date().toISOString() });
      setSaveFailure(failure);
    });
  }

  async function generateSummary() {
    if (!milestone || genSummary) return;
    const milestoneId = milestone.id;
    setGenSummary(true);
    setSummaryFailure(null);
    try {
      const { data, failure } = await requestSave<{
        summaryDoc?: string; generatedAt?: string; saved?: boolean;
      }>(
        () => fetch(`/api/tracker/milestones/${milestoneId}/summary`, { method: "POST" }),
        SUMMARY_HUMAN_REFUSALS,
      );
      if (failure) { setSummaryFailure(failure); return; }
      if (data?.summaryDoc) {
        setSummaryDoc(data.summaryDoc);
        setSummaryAt(data.generatedAt ?? new Date().toISOString());
        // The route answers 200 with `saved: false` when Claude wrote the
        // document but the database would not take it. Showing it anyway is
        // the point: it has already been billed for, and the learner can
        // download it or ask us to store it again.
        setSummaryUnsaved(data.saved === false);
      }
    } finally {
      setGenSummary(false);
    }
  }

  /**
   * Store a summary that was generated but never saved.
   *
   * Deliberately the PUT and not the POST: the document already exists, only
   * the store failed, and going back through generation would bill the learner
   * a second time for words they are currently looking at.
   */
  async function retrySaveSummary() {
    if (!milestone || !summaryDoc || savingSummary) return;
    const milestoneId = milestone.id;
    setSavingSummary(true);
    setSummaryFailure(null);
    try {
      const { failure } = await requestSave(() =>
        fetch(`/api/tracker/milestones/${milestoneId}/summary`, {
          method:  "PUT",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ summaryDoc }),
        }),
      );
      if (failure) { setSummaryFailure(failure); return; }
      setSummaryUnsaved(false);
    } finally {
      setSavingSummary(false);
    }
  }

  function downloadSummary() {
    if (!summaryDoc || !milestone) return;
    downloadMarkdown(milestone.title, summaryDoc);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitEntry();
    }
  }

  // One destination, because there is only one chat surface. This used to fall
  // back to `/learn?topic=…` when a track had no goal behind it — a path that
  // could not actually be reached, since the only page that renders this drawer
  // finds its track BY goal_id and always supplies one. `/learn` has since been
  // deleted; see lib/pomodoro/routes.ts.
  function askHref(): string {
    if (!milestone) return "#";
    const titleParam = encodeURIComponent(milestone.title);
    return `/study/${goalId}/ask?milestoneId=${milestone.id}&milestone=${titleParam}`;
  }

  function quizHref(): string {
    if (!milestone) return "#";
    return `/review/${milestone.id}?returnUrl=${encodeURIComponent(pathname)}`;
  }

  // Archived entries are hidden from the diary and every count/filter — they only
  // surface under the "Show archived" toggle.
  const activeEntries   = entries.filter(e => !e.archived_at);
  const archivedEntries = entries.filter(e => e.archived_at);

  // Two readings of the same load, because the diary and the gates count
  // different things: the diary lists only unarchived entries, while a quiz is
  // built from everything written here. Both go through `diaryState` so neither
  // can go back to reading a failed load as an empty one.
  const diaryView = diaryState({
    loading: loadingEntries, failed: entriesFailed, count: activeEntries.length,
  });
  const gateView  = diaryState({
    loading: loadingEntries, failed: entriesFailed, count: entries.length,
  });

  // Learning-point tag lookups for the diary: id → text, per-point entry counts,
  // and the entries visible under the active filter.
  const pointsById = new Map(points.map(p => [p.id, p.text]));
  const entryCountByPoint = activeEntries.reduce<Record<string, number>>((acc, e) => {
    if (e.point_id) acc[e.point_id] = (acc[e.point_id] ?? 0) + 1;
    return acc;
  }, {});
  const activeFilterText = filterPointId ? pointsById.get(filterPointId) ?? null : null;
  const visibleEntries   = filterPointId
    ? activeEntries.filter(e => e.point_id === filterPointId)
    : activeEntries;

  function focusPointInDiary(pointId: string) {
    setFilterPointId(prev => (prev === pointId ? null : pointId));
    setShowDiary(true);
  }

  const open            = milestone !== null;
  const understoodCount = countByStatus(statuses, "understood");
  const bookmarkedCount = countByStatus(statuses, "bookmarked");
  const stuckCount      = countByStatus(statuses, "stuck");
  const allCovered      = points.length > 0 && understoodCount === points.length;
  const uncheckedCount  = points.length - understoodCount;
  const showNudge       = points.length > 0 && !allCovered && !nudgeDismissed;

  // Gentle, dismissible reminder shown before starting Review / Mastery when the
  // learner hasn't ticked off all of their "What to understand" items. Never blocks.
  const checklistNudge = showNudge ? (
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-3.5 py-2.5">
      <ListChecks size={14} className="mt-0.5 shrink-0 text-amber-400" />
      <p className="flex-1 text-xs leading-relaxed text-amber-200/90">
        You still have {uncheckedCount} {uncheckedCount === 1 ? "idea" : "ideas"}{" "}
        unticked in &ldquo;What to understand.&rdquo; You can carry on, but it&apos;s worth confirming you genuinely have them first.
      </p>
      <button
        onClick={() => setNudgeDismissed(true)}
        className="shrink-0 text-amber-500/60 hover:text-amber-300 transition-colors"
        title="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  ) : null;

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />

      {/* Drawer */}
      <aside
        className={`fixed top-0 right-0 z-40 flex h-full flex-col border-l border-slate-700/80 shadow-2xl transition-all duration-300
          ${expanded ? "w-full bg-[#0A0F1E]" : "w-full max-w-md bg-slate-900"}
          ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {/* Breathing orbs — only in expanded mode */}
        {expanded && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="animate-breathe absolute top-0 left-0 h-[600px] w-[600px] -translate-x-1/3 -translate-y-1/3 rounded-full bg-sky-500/20 blur-3xl" />
            <div className="animate-breathe-delayed absolute bottom-0 right-0 h-[700px] w-[700px] translate-x-1/3 translate-y-1/3 rounded-full bg-violet-500/15 blur-3xl" />
            <div className="animate-breathe-slow absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[400px] w-[400px] rounded-full bg-sky-400/10 blur-3xl" />
          </div>
        )}

        {milestone && (
          <div className="relative z-10 flex flex-1 min-h-0 flex-col">

            {/* Sticky header */}
            <div className="shrink-0 flex items-start justify-between gap-4 border-b border-slate-700/60 px-6 py-5">
              <div className="flex-1 min-w-0">
                <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold mb-2 ${COLUMN_COLOURS[milestone.kanban_column]}`}>
                  {KANBAN_COLUMN_LABELS[milestone.kanban_column]}
                </span>
                <h2 className="text-base font-semibold text-slate-100 leading-snug">
                  {milestone.title}
                </h2>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => setExpanded(v => !v)}
                  className="rounded-lg p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                  title={expanded ? "Collapse to sidebar" : "Expand to full screen"}
                >
                  {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
                <button
                  onClick={onClose}
                  className="rounded-lg p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className={expanded ? "max-w-3xl mx-auto" : ""}>

                {/* ── Overview ───────────────────────────────────────── */}
                <div className="border-b border-slate-700/40 px-6">
                  <SectionToggle
                    label="Overview"
                    open={showOverview}
                    onToggle={() => setShowOverview(v => !v)}
                  />
                  {showOverview && (
                    <p className="pb-4 text-sm text-slate-300 leading-relaxed">
                      {milestone.summary}
                    </p>
                  )}
                </div>

                {/* ── What to understand (goal checklist + coverage) ──── */}
                <div className="border-b border-slate-700/40 px-6">
                  <SectionToggle
                    label="What to understand"
                    icon={<ListChecks size={13} />}
                    open={showPoints}
                    onToggle={() => setShowPoints(v => !v)}
                    count={points.length || undefined}
                  />
                  {showPoints && (
                    <div className="pb-4">
                      {loadingCoverage && points.length === 0 ? (
                        <div className="flex items-center gap-2 py-2 text-xs text-slate-500">
                          <Loader2 size={12} className="animate-spin" />
                          Building your checklist…
                        </div>
                      ) : coverageFailed ? (
                        <p className="py-2 text-xs leading-relaxed text-slate-400">
                          The checklist could not be built. Nothing is wrong
                          with this card — close and reopen it to try again.
                        </p>
                      ) : points.length === 0 ? (
                        <p className="py-2 text-xs text-slate-600">
                          Checklist unavailable right now.
                        </p>
                      ) : (
                        <>
                          <ol className="space-y-1">
                            {points.map(p => (
                              <li
                                key={p.id}
                                className="flex items-start justify-between gap-2.5 rounded-lg py-1 pl-2 pr-1"
                              >
                                <span className="flex-1 text-sm leading-snug text-slate-300">
                                  {p.text}
                                </span>
                                {entryCountByPoint[p.id] > 0 && (
                                  <button
                                    onClick={() => focusPointInDiary(p.id)}
                                    title="Show tagged diary entries"
                                    className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
                                      filterPointId === p.id
                                        ? "bg-violet-500/25 text-violet-200"
                                        : "bg-slate-800 text-slate-500 hover:text-violet-300"
                                    }`}
                                  >
                                    {entryCountByPoint[p.id]} {entryCountByPoint[p.id] === 1 ? "note" : "notes"}
                                  </button>
                                )}
                                <PointStatusControl
                                  current={statuses[p.id]}
                                  onChange={next => setPointStatus(p.id, next)}
                                />
                              </li>
                            ))}
                          </ol>
                          <div className="mt-3">
                            <span className={`text-xs font-medium ${allCovered ? "text-green-400" : "text-slate-500"}`}>
                              {allCovered
                                ? "All ideas marked understood — nicely done"
                                : `${understoodCount} of ${points.length} understood`}
                              {bookmarkedCount > 0 && <span className="text-amber-400"> · {bookmarkedCount} bookmarked</span>}
                              {stuckCount > 0 && <span className="text-red-400"> · {stuckCount} to revisit</span>}
                            </span>
                            <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
                              Flag each idea as understood, bookmarked for later, or still unclear — your own honest progress check.
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* ── Review (only for review-column cards) ──────────── */}
                {milestone.kanban_column === "review" && (
                  <div className="border-b border-slate-700/40 px-6">
                    <SectionToggle
                      label="Review"
                      icon={
                        milestone.review_validated
                          ? <CheckCircle2 size={13} className="text-green-400" />
                          : <OctagonAlert size={13} className="text-red-400" />
                      }
                      open={showReview}
                      onToggle={() => setShowReview(v => !v)}
                    />
                    {showReview && (
                      <div className="pb-4 space-y-3">
                        {milestone.review_validated ? (
                          <div className="flex items-center gap-2.5 rounded-xl border border-green-500/30 bg-green-500/8 px-4 py-3">
                            <CheckCircle2 size={16} className="shrink-0 text-green-400" />
                            <div>
                              <p className="text-sm font-semibold text-green-300">Validated</p>
                              <p className="text-xs text-slate-500">This card has passed review.</p>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-start gap-2.5 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
                              <OctagonAlert size={15} className="shrink-0 mt-0.5 text-red-400" />
                              <p className="text-sm text-slate-300 leading-relaxed">
                                This card is not yet validated. Pass a short quiz based on your learning diary to mark it as reviewed.
                              </p>
                            </div>

                            {checklistNudge}

                            {gateView === "loading" ? (
                              <div className="flex items-center gap-2 text-xs text-slate-500 px-1">
                                <Loader2 size={12} className="animate-spin" />
                                Checking learning activity…
                              </div>
                            ) : gateView === "failed" ? (
                              <div className="rounded-xl border border-red-500/30 bg-red-500/8 px-4 py-3">
                                <p className="text-sm leading-relaxed text-red-200/90">
                                  We couldn&apos;t check your learning diary, so this is on hold.
                                  Nothing is lost — it just didn&apos;t load.
                                </p>
                                <button
                                  onClick={() => { if (milestone) void loadEntries(milestone.id); }}
                                  className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-red-300 transition-colors hover:text-red-100"
                                >
                                  <RotateCw size={11} />
                                  Try again
                                </button>
                              </div>
                            ) : !canStartFromDiary(gateView) ? (
                              <div className="rounded-xl border border-slate-700/60 bg-slate-800/50 px-4 py-3">
                                <p className="text-sm text-slate-400 leading-relaxed">
                                  Add at least one learning diary entry before starting the review quiz.
                                </p>
                              </div>
                            ) : (
                              <Link
                                href={quizHref()}
                                className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-700/70 border border-amber-600/40 px-4 py-2.5 text-sm font-semibold text-amber-100 hover:bg-amber-700 transition-colors"
                              >
                                <ClipboardCheck size={14} />
                                Start Review Quiz
                                <span className="text-xs font-normal text-amber-300/70">({entries.length} {entries.length === 1 ? "entry" : "entries"})</span>
                              </Link>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Mastery (only for done-column cards) ───────────── */}
                {milestone.kanban_column === "done" && (
                  <div className="border-b border-slate-700/40 px-6">
                    <SectionToggle
                      label="Mastery"
                      icon={
                        milestone.mastery_validated
                          ? <CheckCircle2 size={13} className="text-green-400" />
                          : <OctagonAlert size={13} className="text-red-400" />
                      }
                      open={showMastery}
                      onToggle={() => setShowMastery(v => !v)}
                    />
                    {showMastery && (
                      <div className="pb-4 space-y-3">
                        {milestone.mastery_validated ? (
                          <>
                            <div className="flex items-center gap-2.5 rounded-xl border border-green-500/30 bg-green-500/8 px-4 py-3">
                              <CheckCircle2 size={16} className="shrink-0 text-green-400" />
                              <div>
                                <p className="text-sm font-semibold text-green-300">Mastered</p>
                                <p className="text-xs text-slate-500">This card has been verbally professed and confirmed.</p>
                              </div>
                            </div>

                            {/* Practice again — re-run the session without leaving the Mastered column */}
                            {liveAvailable ? <Link
                              href={`/mastery/${milestone.id}?returnUrl=${encodeURIComponent(pathname)}`}
                              className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-2.5 text-sm font-semibold text-slate-300 hover:border-slate-600 hover:bg-slate-800 transition-colors"
                            >
                              <Mic size={14} />
                              Practice again
                              <span className="text-xs font-normal text-slate-500">stays mastered</span>
                            </Link> : <p className="text-xs text-slate-500">Live voice practice is temporarily unavailable.</p>}

                            {/* ── Learning summary document ─────────────────── */}
                            <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-4 space-y-3">
                              <div className="flex items-center justify-between gap-2">
                                <button
                                  onClick={() => setShowSummary(v => !v)}
                                  className="flex flex-1 items-center gap-2 text-left"
                                >
                                  <ChevronDown
                                    size={13}
                                    className={`shrink-0 text-slate-500 transition-transform duration-200 ${showSummary ? "" : "-rotate-90"}`}
                                  />
                                  <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-slate-500">
                                    <FileText size={13} />
                                    Learning summary
                                  </span>
                                </button>
                                {summaryDoc && !genSummary && showSummary && (
                                  <div className="flex items-center gap-3">
                                    <button
                                      onClick={generateSummary}
                                      className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 transition-colors"
                                    >
                                      <RotateCw size={11} />
                                      Regenerate
                                    </button>
                                    <button
                                      onClick={downloadSummary}
                                      className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                                    >
                                      <Download size={11} />
                                      Download
                                    </button>
                                  </div>
                                )}
                              </div>

                              {showSummary && (
                                genSummary ? (
                                  <div className="flex items-center gap-2 py-2 text-xs text-slate-500">
                                    <Loader2 size={12} className="animate-spin" />
                                    Hugh is writing your summary…
                                  </div>
                                ) : summaryDoc ? (
                                  <>
                                    {summaryUnsaved && (
                                      <div className="rounded-lg border border-amber-500/40 bg-amber-500/8 px-4 py-3">
                                        <p className="text-sm leading-relaxed text-amber-100/90">
                                          This summary couldn&apos;t be saved. It won&apos;t be here
                                          when you reopen the card — use Download if you want to
                                          keep it.
                                        </p>
                                        {summaryFailure && (
                                          <p className="mt-1.5 text-xs leading-relaxed text-amber-200/70">
                                            {summaryFailure.message}
                                          </p>
                                        )}
                                        <button
                                          onClick={retrySaveSummary}
                                          disabled={savingSummary}
                                          className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-amber-200 transition-colors hover:text-amber-50 disabled:opacity-50"
                                        >
                                          {savingSummary
                                            ? <Loader2 size={11} className="animate-spin" />
                                            : <RotateCw size={11} />}
                                          Try saving again
                                        </button>
                                      </div>
                                    )}
                                    <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-4 py-3">
                                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={summaryMarkdownComponents}>
                                        {summaryDoc}
                                      </ReactMarkdown>
                                    </div>
                                    {summaryAt && (
                                      <p className="text-xs text-slate-600">Generated {fmtCompact(summaryAt)}</p>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    {/* A failed generation used to drop straight back to
                                        the button below with nothing said, so pressing it
                                        again was the only way to learn anything. */}
                                    {summaryFailure && (
                                      <div className="rounded-lg border border-red-500/30 bg-red-500/8 px-4 py-3">
                                        <p className="text-sm leading-relaxed text-red-200/90">
                                          {summaryFailure.message}
                                        </p>
                                      </div>
                                    )}
                                    <p className="text-sm text-slate-400 leading-relaxed">
                                      Generate a document summarising what you learned here — drawn from your diary, the checklist, and your mastery session.
                                    </p>
                                    <button
                                      onClick={generateSummary}
                                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-green-600/40 bg-green-700/50 px-4 py-2.5 text-sm font-semibold text-green-100 hover:bg-green-700 transition-colors"
                                    >
                                      <Sparkles size={14} />
                                      Generate summary
                                    </button>
                                  </>
                                )
                              )}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-start gap-2.5 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
                              <OctagonAlert size={15} className="shrink-0 mt-0.5 text-red-400" />
                              <p className="text-sm text-slate-300 leading-relaxed">
                                This card is not yet confirmed. Live voice mastery is temporarily unavailable while usage controls are completed.
                              </p>
                            </div>

                            {checklistNudge}

                            {!liveAvailable ? (
                              <div className="rounded-xl border border-slate-700/60 bg-slate-800/50 px-4 py-3">
                                <p className="text-sm text-slate-400 leading-relaxed">
                                  Live voice mastery is being prepared for paying learners.
                                </p>
                              </div>
                            ) : gateView === "loading" ? (
                              <div className="flex items-center gap-2 text-xs text-slate-500 px-1">
                                <Loader2 size={12} className="animate-spin" />
                                Checking learning activity…
                              </div>
                            ) : gateView === "failed" ? (
                              <div className="rounded-xl border border-red-500/30 bg-red-500/8 px-4 py-3">
                                <p className="text-sm leading-relaxed text-red-200/90">
                                  We couldn&apos;t check your learning diary, so this is on hold.
                                  Nothing is lost — it just didn&apos;t load.
                                </p>
                                <button
                                  onClick={() => { if (milestone) void loadEntries(milestone.id); }}
                                  className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-red-300 transition-colors hover:text-red-100"
                                >
                                  <RotateCw size={11} />
                                  Try again
                                </button>
                              </div>
                            ) : !canStartFromDiary(gateView) ? (
                              <div className="rounded-xl border border-slate-700/60 bg-slate-800/50 px-4 py-3">
                                <p className="text-sm text-slate-400 leading-relaxed">
                                  Add at least one learning diary entry before starting a mastery session.
                                </p>
                              </div>
                            ) : (
                              <Link
                                href={`/mastery/${milestone.id}?returnUrl=${encodeURIComponent(pathname)}`}
                                className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-700/70 border border-green-600/40 px-4 py-2.5 text-sm font-semibold text-green-100 hover:bg-green-700 transition-colors"
                              >
                                <Mic size={14} />
                                Begin Mastery Session
                                <span className="text-xs font-normal text-green-300/70">({entries.length} {entries.length === 1 ? "entry" : "entries"})</span>
                              </Link>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Actions ────────────────────────────────────────── */}
                <div className="border-b border-slate-700/40 px-6">
                  <SectionToggle
                    label="Actions"
                    open={showActions}
                    onToggle={() => setShowActions(v => !v)}
                  />
                  {showActions && (
                    <div className="pb-4">
                      <Link
                        href={askHref()}
                        className="glow-violet flex items-center justify-between gap-3 rounded-xl border border-violet-500/30 bg-violet-500/8 px-4 py-3 transition-all hover:border-violet-500/60 hover:bg-violet-500/15 group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-400">
                            <MessageCircle size={15} />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-violet-300">Ask Hugh about this</p>
                            <p className="text-xs text-slate-500">Full chat — summarise, deep-dive, examples</p>
                          </div>
                        </div>
                        <ArrowRight size={15} className="shrink-0 text-violet-500 transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    </div>
                  )}
                </div>

                {/* ── Learning diary ─────────────────────────────────── */}
                <div className="px-6">
                  <SectionToggle
                    label="Learning diary"
                    icon={<BookOpen size={13} />}
                    open={showDiary}
                    onToggle={() => setShowDiary(v => !v)}
                    count={activeEntries.length || undefined}
                  />

                  {showDiary && (
                    <>
                      {diaryView === "loading" && (
                        <div className="flex justify-center py-6">
                          <Loader2 size={18} className="animate-spin text-slate-500" />
                        </div>
                      )}
                      {/* Not the same sentence as "you have written nothing", which
                          is what this used to show. Modelled on the checklist
                          failure above: name it, and offer the way back. */}
                      {diaryView === "failed" && (
                        <div className="my-2 rounded-xl border border-red-500/30 bg-red-500/8 px-4 py-3">
                          <p className="text-sm leading-relaxed text-red-200/90">
                            We couldn&apos;t load your learning diary. Your entries are
                            safe — this screen just didn&apos;t get them.
                          </p>
                          <button
                            onClick={() => { if (milestone) void loadEntries(milestone.id); }}
                            className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-red-300 transition-colors hover:text-red-100"
                          >
                            <RotateCw size={11} />
                            Try again
                          </button>
                        </div>
                      )}
                      {diaryView === "empty" && (
                        <p className="py-6 text-center text-xs text-slate-600">
                          {archivedEntries.length > 0
                            ? "No active entries — all your notes here are archived."
                            : "No entries yet — log your first insight below."}
                        </p>
                      )}

                      {/* Active learning-point filter */}
                      {filterPointId && (
                        <div className="mb-2 flex items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/8 px-3 py-2">
                          <Tag size={12} className="shrink-0 text-violet-400" />
                          <span className="flex-1 truncate text-xs text-violet-200">
                            {activeFilterText ?? "Tagged entries"}
                          </span>
                          <button
                            onClick={() => setFilterPointId(null)}
                            className="shrink-0 text-violet-400/70 transition-colors hover:text-violet-200"
                            title="Clear filter"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      )}
                      {diaryView === "ready" && visibleEntries.length === 0 && (
                        <p className="py-6 text-center text-xs text-slate-600">
                          No entries tagged to this learning point yet.
                        </p>
                      )}

                      <div className="space-y-2 pb-4">
                        {visibleEntries.map(entry => {
                          const isOpen      = openEntries.has(entry.id);
                          const isEditing   = editingId === entry.id;
                          const isVerifying = verifyingIds.has(entry.id);
                          const showWarning = entry.fact_status === "incorrect" && !entry.corrected;
                          const label       = entry.title || entry.body.slice(0, 65) + (entry.body.length > 65 ? "…" : "");
                          return (
                            <div
                              key={entry.id}
                              className={`relative rounded-lg border overflow-hidden transition-colors ${
                                isVerifying
                                  ? "border-sky-500/40 bg-sky-950/10"
                                  : showWarning
                                  ? "border-amber-500/40 bg-amber-950/10"
                                  : "border-slate-700/50 bg-slate-800/50"
                              }`}
                            >
                              {/* Indeterminate shimmer while Hugh fact-checks */}
                              {isVerifying && (
                                <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-sky-500/10">
                                  <div className="h-full w-1/3 bg-sky-400/80 animate-progress-slide" />
                                </div>
                              )}
                              <button
                                onClick={() => toggleEntry(entry.id)}
                                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-slate-800/80 transition-colors"
                              >
                                <ChevronDown
                                  size={13}
                                  className={`shrink-0 text-slate-500 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                                />
                                <span className="flex-1 min-w-0 truncate text-xs font-semibold text-violet-400">
                                  {label}
                                </span>
                                {isVerifying ? (
                                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                                    <Loader2 size={10} className="animate-spin" />
                                    Checking
                                  </span>
                                ) : showWarning ? (
                                  <AlertTriangle size={12} className="shrink-0 text-amber-400 animate-fadeIn" />
                                ) : entry.fact_status === "correct" ? (
                                  <Check size={12} className="shrink-0 text-green-500/70 animate-fadeIn" />
                                ) : null}
                                {entry.point_id && (
                                  <Tag size={11} className="shrink-0 text-violet-400/70" />
                                )}
                                <span className="shrink-0 text-xs text-slate-600">
                                  {fmtCompact(entry.created_at)}
                                </span>
                              </button>

                              {isOpen && (
                                <div className="border-t border-slate-700/40 px-3 py-3 pl-8 space-y-3">
                                  {isEditing ? (
                                    <div className="space-y-2">
                                      <input
                                        type="text"
                                        value={editTitle}
                                        onChange={e => setEditTitle(e.target.value)}
                                        placeholder="Title (optional)"
                                        className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-sky-500"
                                      />
                                      <textarea
                                        value={editBody}
                                        onChange={e => setEditBody(e.target.value)}
                                        rows={4}
                                        className="w-full resize-none rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-sky-500"
                                      />
                                      <div className="flex items-center gap-2">
                                        <button
                                          onClick={() => saveEdit(entry.id)}
                                          disabled={!editBody.trim()}
                                          className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-40 transition-colors"
                                        >
                                          Save &amp; re-check
                                        </button>
                                        <button
                                          onClick={() => setEditingId(null)}
                                          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
                                      {entry.body}
                                    </p>
                                  )}

                                  {/* Live fact-check status — keeps the learner on the page */}
                                  {isVerifying && !isEditing && (
                                    <div className="flex items-center gap-2 rounded-lg border border-sky-500/25 bg-sky-500/8 px-3 py-2 animate-fadeIn">
                                      <Sparkles size={13} className="shrink-0 text-sky-400 animate-pulse" />
                                      <span className="text-xs font-medium text-sky-200">Hugh is fact-checking this entry</span>
                                      <span className="ml-0.5 flex items-center gap-0.5">
                                        <span className="h-1 w-1 rounded-full bg-sky-400 animate-bounce" style={{ animationDelay: "-0.3s" }} />
                                        <span className="h-1 w-1 rounded-full bg-sky-400 animate-bounce" style={{ animationDelay: "-0.15s" }} />
                                        <span className="h-1 w-1 rounded-full bg-sky-400 animate-bounce" />
                                      </span>
                                    </div>
                                  )}

                                  {/* Fact-check warning — clickable correction */}
                                  {showWarning && !isEditing && (
                                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2.5 animate-fadeIn">
                                      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                                        <AlertTriangle size={13} />
                                        Hugh thinks this needs a fix
                                      </div>
                                      {entry.correction && (
                                        <div>
                                          <p className="mb-1 text-xs uppercase tracking-wider text-slate-600">Suggested correction</p>
                                          <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
                                            {entry.correction}
                                          </p>
                                        </div>
                                      )}
                                      <div className="flex items-center gap-2">
                                        <button
                                          onClick={() => acceptFix(entry.id)}
                                          className="flex items-center gap-1 rounded-lg bg-amber-600/80 px-3 py-1.5 text-xs font-semibold text-amber-50 hover:bg-amber-600 transition-colors"
                                        >
                                          <Check size={12} />
                                          Accept fix
                                        </button>
                                        <button
                                          onClick={() => startEdit(entry)}
                                          className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                                        >
                                          <Pencil size={11} />
                                          Rewrite myself
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {/* Permanent gap footnote — stays after correction */}
                                  {entry.gap_note && (
                                    <div className="flex items-start gap-1.5 border-t border-slate-700/40 pt-2.5 text-xs leading-relaxed text-slate-500">
                                      <Paperclip size={11} className="mt-0.5 shrink-0 text-slate-600" />
                                      <span>
                                        <span className="font-semibold text-slate-400">Gap noted:</span>{" "}
                                        {entry.gap_note}
                                      </span>
                                    </div>
                                  )}

                                  {/* Re-tag to a learning point */}
                                  {points.length > 0 && !isEditing && (
                                    <div className="flex items-center gap-2 border-t border-slate-700/40 pt-2.5">
                                      <span className="shrink-0 text-xs text-slate-600">Learning point</span>
                                      <PointTagSelect
                                        points={points}
                                        value={entry.point_id}
                                        onChange={id => retagEntry(entry.id, id)}
                                        className="flex-1"
                                      />
                                    </div>
                                  )}

                                  {/* Row actions: edit (no warning) + archive to declutter */}
                                  {!isEditing && (
                                    <div className="flex items-center gap-4">
                                      {!showWarning && (
                                        <button
                                          onClick={() => startEdit(entry)}
                                          className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-400 transition-colors"
                                        >
                                          <Pencil size={10} />
                                          Edit
                                        </button>
                                      )}
                                      <button
                                        onClick={() => setArchived(entry.id, true)}
                                        title="Archive this note — you can restore it from “Show archived”"
                                        className="ml-auto flex items-center gap-1 text-xs text-slate-600 hover:text-red-400 transition-colors"
                                      >
                                        <Archive size={11} />
                                        Archive
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        <div ref={entriesEndRef} />
                      </div>

                      {/* Archived notes — hidden by default; restore anytime. */}
                      {archivedEntries.length > 0 && (
                        <div className="pb-4">
                          <button
                            onClick={() => setShowArchived(v => !v)}
                            className="flex items-center gap-1.5 text-xs text-slate-600 transition-colors hover:text-slate-400"
                          >
                            <Archive size={11} />
                            {showArchived ? "Hide" : "Show"} archived ({archivedEntries.length})
                            <ChevronDown
                              size={12}
                              className={`transition-transform ${showArchived ? "" : "-rotate-90"}`}
                            />
                          </button>

                          {showArchived && (
                            <div className="mt-2 space-y-1.5">
                              {archivedEntries.map(entry => (
                                <div
                                  key={entry.id}
                                  className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2"
                                >
                                  <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
                                    {entry.title || entry.body.slice(0, 65) + (entry.body.length > 65 ? "…" : "")}
                                  </span>
                                  <span className="shrink-0 text-xs text-slate-700">
                                    {fmtCompact(entry.created_at)}
                                  </span>
                                  <button
                                    onClick={() => setArchived(entry.id, false)}
                                    title="Restore this note to the diary"
                                    className="flex shrink-0 items-center gap-1 text-xs text-slate-500 transition-colors hover:text-sky-400"
                                  >
                                    <RotateCw size={11} />
                                    Restore
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>

              </div>
            </div>

            {/* ── Log what I learned — collapsible, sticky at bottom ── */}
            <div className="shrink-0 border-t border-slate-700/60">
              <div className={expanded ? "max-w-3xl mx-auto" : ""}>
                <div className="px-6">
                  <SectionToggle
                    label="Log what I learned"
                    icon={<PenLine size={13} />}
                    open={showWriteEntry}
                    onToggle={() => setShowWriteEntry(v => !v)}
                  />
                </div>

                {showWriteEntry && (
                  <div className="px-6 pb-4">
                    <input
                      type="text"
                      value={draftTitle}
                      onChange={e => setDraftTitle(e.target.value)}
                      placeholder="Entry title (optional)"
                      className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-sky-500 transition-colors mb-2"
                    />
                    <textarea
                      ref={textareaRef}
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Write a thought, insight, or note…"
                      rows={3}
                      className="w-full resize-none rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-sky-500 transition-colors"
                    />
                    {points.length > 0 && (
                      <div className="mt-2">
                        <PointTagSelect points={points} value={draftPointId} onChange={setDraftPointId} />
                      </div>
                    )}
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-xs text-slate-600">Hugh fact-checks each entry · ⌘ Enter to save</span>
                      <button
                        onClick={submitEntry}
                        disabled={!draft.trim() || saving}
                        className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {saving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                        Add entry
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Anchored inside the panel rather than the viewport, so it cannot
                land on top of the board's own toast behind it. */}
            {saveFailure && (
              <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex justify-center">
                <div className="pointer-events-auto animate-toast-in">
                  <SaveFailureNotice
                    failure={saveFailure}
                    title="Not saved"
                    onDismiss={() => setSaveFailure(null)}
                  />
                </div>
              </div>
            )}

          </div>
        )}
      </aside>
    </>
  );
}
