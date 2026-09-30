"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookMarked, Sparkles, Loader2, Upload, FileText, ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { type LearningGoal } from "@/types";
import { classifyTopic, mayProceed, type TopicDomainVerdict } from "@/lib/learn/topic-domain";
import TopicGateNotice from "./TopicGateNotice";
import { MAX_TOPIC_CHARS } from "@/lib/learn/topicInput";
import { recordAttempt } from "@/lib/learn/gateHistory";
import GoalCard from "./GoalCard";
import RefinementFlow from "./RefinementFlow";
import IdeaConstellation from "./IdeaConstellation";
import ThoughtTrail, { type Thought } from "./ThoughtTrail";
import { type GroupProgress } from "@/lib/learn/constellation";
import { type RefinementPhase } from "@/lib/learn/network";
import { MAX_ORBITS, type InFlightGoal } from "@/lib/learn/progress";
import { isRegionId } from "@/lib/learn/regions";
import DocumentUploadFlow, { ACCEPT as DOCUMENT_ACCEPT } from "./DocumentUploadFlow";

type InputMode = "qa" | "document";

interface Props {
  initialGoals: LearningGoal[];
  /**
   * How lit each region of the constellation is. `null` means the read failed
   * — distinct from `{}`, which means a learner who genuinely has nothing yet.
   */
  regionProgress: GroupProgress | null;
  /** Goals the learner is working through, shown orbiting their clusters. */
  inFlight: InFlightGoal[];
  /**
   * Whether the course-from-document path is open. Locked by default — see
   * lib/learn/documentPath.ts. The routes refuse regardless; this only decides
   * whether the learner is offered a door that would not open.
   */
  documentUpload: boolean;
}

type DurationChip = "2w" | "1m" | "3m" | "custom";

/**
 * How many goals the library shows before folding the rest away.
 *
 * Four fits the screen alongside the form, which is the whole constraint: this
 * is a teaching surface, and rule 4 says it loses padding or gains pagination
 * before it gains a scrollbar.
 */
const VISIBLE_GOALS = 4;

/** How long the library takes to fade out before a page swap, and back in after. */
const PAGE_FADE_MS = 160;

const CHIPS: { id: DurationChip; label: string; days: number | null }[] = [
  { id: "2w",     label: "2 weeks",  days: 14 },
  { id: "1m",     label: "1 month",  days: 30 },
  { id: "3m",     label: "3 months", days: 90 },
  { id: "custom", label: "Custom",   days: null },
];

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0]!;
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0]!;
}

export default function DashboardPanel({
  initialGoals, regionProgress, inFlight, documentUpload,
}: Props) {
  const [goals, setGoals]       = useState<LearningGoal[]>(initialGoals);
  const [topic, setTopic]       = useState("");
  const [chip, setChip]         = useState<DurationChip | null>(null);
  const [customDate, setCustomDate] = useState("");

  // Which input the idle "Add goal" form shows — a typed topic (Q&A
  // refinement) or a document upload. Only relevant when neither flow below
  // has been entered yet.
  // Always starts at "qa". The document mode is only reachable through the
  // toggle above, which is not rendered while the path is locked.
  const [inputMode, setInputMode] = useState<InputMode>("qa");

  // Refinement flow state
  const [refining, setRefining]       = useState(false);
  const [pendingTopic, setPendingTopic] = useState("");
  const [pendingEndDate, setPendingEndDate] = useState("");

  // Document upload flow state
  const [uploadingDoc, setUploadingDoc] = useState(false);
  // Picked in the idle panel, before "Continue" — carried into
  // DocumentUploadFlow as its initialFile so the user only picks once.
  const [docFile, setDocFile]     = useState<File | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Domain gate: judge the topic before building anything. `gate` holds any
  // verdict that stopped the build — either a request to pick a data angle
  // or the kind reminder that the topic is outside Hugh's domain.
  const [checking, setChecking] = useState(false);
  const [gate, setGate]         = useState<TopicDomainVerdict | null>(null);

  // Phrasings the gate has already asked this learner to narrow. Sent back on
  // the next call so a second try does not return the same three suggestions
  // they just turned down — the judge is stateless, and that is what makes a
  // gate feel like a loop. Never influences the verdict; see the prompt.
  const [attemptHistory, setAttemptHistory] = useState<string[]>([]);

  // True once the learner has taken up "I'll describe it". Holds the question
  // on screen while they type it out, which is otherwise dismissed by the first
  // keystroke.
  const [writingOwn, setWritingOwn] = useState(false);

  const topicRef = useRef<HTMLInputElement>(null);

  // What Hugh said on the way through. Empty for almost every topic; set when
  // the learner named a TOOL, where the gate passes them but wants them to know
  // Hugh teaches the thinking behind it rather than the product itself. Carried
  // into the refinement flow so it is read before any time is invested.
  const [lensNote, setLensNote] = useState("");

  // What the learner has told Hugh so far, mirrored here for the panel beside
  // the form. RefinementFlow remains the owner — this is a projection for
  // rendering, and nothing writes back through it.
  const [trail, setTrail] = useState<{
    answers: Thought[]; question: string | null; phase: RefinementPhase;
  }>({ answers: [], question: null, phase: "asking" });

  // The orbits, kept in state rather than read straight from the prop.
  //
  // The prop is computed on the server when the page loads, so a goal created
  // in this session would not appear until a reload — the learner finishes the
  // questions, watches their track build, and the sphere carries on showing the
  // work they had before. A goal created just now is in flight by definition:
  // it exists, it has not failed, and nothing in it can be mastered yet.
  const [flight, setFlight] = useState<InFlightGoal[]>(inFlight);

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

  // Stable, or RefinementFlow's reporting effect fires on every render here.
  const handleProgress = useCallback(
    (p: { answers: Thought[]; question: string | null; phase: RefinementPhase }) =>
      setTrail(p),
    [],
  );

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

  const today = todayStr();

  // What the aside shows.
  //
  // The ideas hold until the learner COMMITS — pressing "Let's Discuss", which
  // is when `checking` goes true — rather than going on the first keystroke.
  // Fading them while someone is still typing pulls half the page away
  // mid-thought, and typing is not a decision: they may still be reading the
  // sphere for what to write. If the gate then declines the topic, `checking`
  // drops back and the ideas return, which is right — that learner is choosing
  // again.
  const showTrail = refining;
  const showIdeas = !refining && !uploadingDoc && !checking;

  function resolvedEndDate(): string {
    if (!chip) return "";
    if (chip === "custom") return customDate;
    const c = CHIPS.find(c => c.id === chip)!;
    return addDays(c.days!);
  }

  const endDate    = resolvedEndDate();
  const canSubmit  = topic.trim().length > 0 && endDate.length > 0;

  // The learner has done their part and only the date is outstanding. The
  // submit button is disabled in this state and says nothing about why, and
  // Enter silently does nothing — so the row that is actually missing has to
  // speak up itself, rather than leaving someone to guess which of the two
  // controls above it is the problem. Derived, not stored: it is a fact about
  // the form, and a second copy of it could go stale.
  const awaitingDate =
    endDate.length === 0 &&
    (inputMode === "qa" ? topic.trim().length > 0 : docFile !== null);

  async function handleFinalize() {
    if (!canSubmit || checking) return;
    const candidate = topic.trim();

    setChecking(true);
    setGate(null);
    setWritingOwn(false);

    // Strict domain gate — block out-of-domain topics before any track is built.
    // The history rides along so the judge can answer what they have already
    // tried; it is context for the reply, not for the verdict.
    const verdict = await classifyTopic(candidate, attemptHistory);
    setChecking(false);

    // recordAttempt decides what is worth carrying: only a 'needs_angle' is
    // remembered, so a declined topic never becomes context arguing for the
    // next one.
    setAttemptHistory(h => recordAttempt(h, candidate, verdict.verdict));

    if (!mayProceed(verdict)) {
      setGate(verdict);
      return;
    }

    setLensNote(verdict.message);
    setPendingTopic(candidate);
    setPendingEndDate(endDate);
    setRefining(true);
  }

  function handleTopicChange(value: string) {
    setTopic(value);
    // Editing normally dismisses the question. Not while the learner is writing
    // their own angle: the question is the thing they are answering, and taking
    // it off screen at the first keystroke is how you get a blank stare.
    if (gate && !writingOwn) setGate(null);
  }

  function handlePickSuggestion(suggestion: string) {
    setWritingOwn(false);
    setTopic(suggestion);
    setGate(null);
  }

  // "Something else — I'll describe it": hand them the field with the broad
  // topic selected, so typing replaces it and arrowing away still keeps it.
  function handleWriteOwn() {
    setWritingOwn(true);
    topicRef.current?.focus();
    topicRef.current?.select();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") void handleFinalize();
  }

  function handleGoalCreated(goal: LearningGoal) {
    setGoals(prev => [goal, ...prev]);
    // The new goal is prepended, so page 0 is where the learner will look for
    // the thing they just made.
    setGoalPage(0);
    if (isRegionId(goal.region)) {
      setFlight(prev => [
        { id: goal.id, topic: goal.topic, region: goal.region as string },
        ...prev.filter(f => f.id !== goal.id),
      ].slice(0, MAX_ORBITS));
    }
    setAttemptHistory([]);
    setWritingOwn(false);
    setLensNote("");
    setTrail({ answers: [], question: null, phase: "asking" });
    setRefining(false);
    setUploadingDoc(false);
    setInputMode("qa");
    setTopic("");
    setChip(null);
    setCustomDate("");
    setPendingTopic("");
    setPendingEndDate("");
    setDocFile(null);
    setPendingFile(null);
  }

  // Reset — the refinement flow's only way out, and deliberately a full one.
  // The answers a learner has given were drawn out by a topic they are now
  // abandoning, so keeping either half would hand them back a half-refined
  // goal they never asked for. Nothing is written until enterWaiting, so there
  // is no goal row to clean up: this is local state and the domain gate's
  // verdict, both cleared.
  function handleResetRefinement() {
    setRefining(false);
    setAttemptHistory([]);
    setWritingOwn(false);
    setLensNote("");
    setTrail({ answers: [], question: null, phase: "asking" });
    setInputMode("qa");
    setTopic("");
    setChip(null);
    setCustomDate("");
    setPendingTopic("");
    setPendingEndDate("");
    setDocFile(null);
    setPendingFile(null);
    setGate(null);
  }

  function handleStartUpload() {
    if (!endDate || !docFile) return;
    setPendingEndDate(endDate);
    setPendingFile(docFile);
    setUploadingDoc(true);
  }

  function handleCancelUpload() {
    setUploadingDoc(false);
  }

  function handleGoalDeleted(id: string) {
    setGoals(prev => prev.filter(g => g.id !== id));
    // A deleted goal is not in flight either — leaving its mote circling would
    // be the same staleness in the other direction.
    setFlight(prev => prev.filter(f => f.id !== id));
  }

  return (
    <div className="flex w-full gap-4 px-4 py-5 sm:gap-10 sm:px-10 sm:py-8">

      {/* ── The form and the library ─────────────────────────────────── */}
      <div className="flex w-full min-w-0 max-w-2xl shrink-0 flex-col gap-6 sm:gap-10">

      {/* ── Add goal ───────────────────────────────────────────────── */}
      <section>
        <h2 className="text-xl font-bold text-slate-100 tracking-tight">
          What do you want to learn?
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          {refining
            ? "Hugh is learning more about your goal to personalize your path."
            : uploadingDoc
            ? "Hugh is scoping a course around your document."
            : "Data, analytics, and everything in between — add a topic and set a commitment date."}
        </p>

        <div className="mt-5">
          {refining ? (
            <RefinementFlow
              topic={pendingTopic}
              endDate={pendingEndDate}
              lensNote={lensNote}
              onProgress={handleProgress}
              onGoalCreated={handleGoalCreated}
              onReset={handleResetRefinement}
            />
          ) : uploadingDoc ? (
            <DocumentUploadFlow
              endDate={pendingEndDate}
              initialFile={pendingFile}
              onGoalCreated={handleGoalCreated}
              onCancel={handleCancelUpload}
            />
          ) : (
            <div className="flex flex-col gap-4">
              {/* Input mode toggle. Only shown when the document path is
                  open: a locked door with a handle on it is worse than no door,
                  because the learner spends a file picker finding out. */}
              {documentUpload && (
                <div className="flex gap-2">
                  <button
                    onClick={() => setInputMode("qa")}
                    className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors
                      ${inputMode === "qa"
                        ? "border-amber-500 bg-amber-500/20 text-amber-300"
                        : "border-slate-700 bg-slate-800 text-slate-500 hover:border-slate-500 hover:text-slate-300"
                      }`}
                  >
                    <Sparkles size={12} />
                    Answer a few questions
                  </button>
                  <button
                    onClick={() => setInputMode("document")}
                    className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors
                      ${inputMode === "document"
                        ? "border-amber-500 bg-amber-500/20 text-amber-300"
                        : "border-slate-700 bg-slate-800 text-slate-500 hover:border-slate-500 hover:text-slate-300"
                      }`}
                  >
                    <Upload size={12} />
                    Upload a document
                  </button>
                </div>

              )}

              {inputMode === "qa" || !documentUpload ? (
                <>
                  {/* Topic input */}
                  <input
                    ref={topicRef}
                    type="text"
                    value={topic}
                    onChange={e => handleTopicChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    maxLength={MAX_TOPIC_CHARS}
                    placeholder="e.g. Statistics for data science, experiment design, dimensional modelling…"
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-500 transition-colors"
                  />

                  {/* Topic gate: asks for an angle, or kindly declines. */}
                  {gate && (
                    <TopicGateNotice
                      verdict={gate}
                      onPickSuggestion={handlePickSuggestion}
                      onWriteOwn={handleWriteOwn}
                    />
                  )}
                </>
              ) : (
                <label
                  htmlFor="document-upload-input-panel"
                  className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-slate-700 bg-slate-800/50 px-4 py-8 text-center hover:border-slate-500 transition-colors"
                >
                  {docFile ? (
                    <>
                      <FileText size={22} className="text-amber-400" />
                      <span className="text-sm text-slate-200">{docFile.name}</span>
                      <span className="text-xs text-slate-600">Click to choose a different file</span>
                    </>
                  ) : (
                    <>
                      <Upload size={22} className="text-slate-500" />
                      <span className="text-sm text-slate-300">Upload a PDF, DOCX, or HTML file</span>
                      <span className="text-xs text-slate-600">
                        A job description, syllabus, or textbook chapter works well
                      </span>
                    </>
                  )}
                  <input
                    id="document-upload-input-panel"
                    type="file"
                    accept={DOCUMENT_ACCEPT}
                    onChange={e => setDocFile(e.target.files?.[0] ?? null)}
                    className="hidden"
                  />
                </label>
              )}

              {/* Commitment chips — shared by both input modes */}
              <div>
                <p
                  className={`mb-2 text-xs font-semibold uppercase tracking-widest transition-colors ${
                    awaitingDate ? "text-amber-400" : "text-slate-500"
                  }`}
                >
                  I&apos;ll commit for
                  {awaitingDate && (
                    <span className="ml-2 normal-case tracking-normal font-medium text-amber-400/80">
                      — pick one to continue
                    </span>
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  {CHIPS.map(c => (
                    <button
                      key={c.id}
                      onClick={() => { setChip(c.id); if (c.id !== "custom") setCustomDate(""); }}
                      className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors
                        ${chip === c.id
                          ? "border-amber-500 bg-amber-500/20 text-amber-300"
                          : awaitingDate
                          ? "border-amber-500/40 bg-slate-800 text-slate-300 hover:border-amber-500 hover:text-amber-200"
                          : "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200"
                        }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>

                {chip === "custom" && (
                  <input
                    type="date"
                    value={customDate}
                    onChange={e => setCustomDate(e.target.value)}
                    min={today}
                    className="mt-3 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-amber-500 transition-colors"
                  />
                )}
              </div>

              {inputMode === "qa" ? (
                <button
                  onClick={handleFinalize}
                  disabled={!canSubmit || checking}
                  className="flex items-center justify-center gap-2 rounded-xl bg-amber-500 py-3 text-sm font-bold text-slate-900 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {checking ? (
                    <>
                      <Loader2 size={15} className="animate-spin" />
                      Checking topic…
                    </>
                  ) : (
                    <>
                      <Sparkles size={15} />
                      Let&apos;s Discuss
                    </>
                  )}
                </button>
              ) : (
                <button
                  onClick={handleStartUpload}
                  disabled={!endDate || !docFile}
                  className="flex items-center justify-center gap-2 rounded-xl bg-amber-500 py-3 text-sm font-bold text-slate-900 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Analyze document
                  <ArrowRight size={15} />
                </button>
              )}
            </div>
          )}
        </div>
      </section>

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

      {goals.length === 0 && !refining && !uploadingDoc && (
        <p className="text-sm text-slate-700 italic">
          Your library is empty — add your first topic above.
        </p>
      )}
      </div>

      {/* ── The aside ────────────────────────────────────────────────────
          Two layers crossfading in the same space rather than one swapping
          for the other: the ideas recede as the learner commits to something,
          and what they have said takes their place. Hidden below xl, where
          there is no room for it and the form is the whole job. */}
      {/* A FIXED height, not a minimum. As a minimum it stretched to whatever
          the column beside it happened to be, so the sphere grew and shrank
          with the number of goal cards — paging the library visibly resized
          the constellation, which is not something the library should be able
          to do. */}
      <aside className="relative hidden h-[38rem] flex-1 xl:block" aria-live="polite">
        <div
          className={`absolute inset-0 transition-opacity duration-700 ${
            showIdeas ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <IdeaConstellation active={showIdeas} progress={regionProgress} inFlight={flight} />
        </div>

        <div
          className={`absolute inset-0 overflow-hidden transition-opacity duration-500 ${
            showTrail ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <ThoughtTrail
            topic={pendingTopic}
            thoughts={trail.answers}
            phase={trail.phase}
          />
        </div>
      </aside>
    </div>
  );
}
