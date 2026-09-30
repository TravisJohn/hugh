"use client";

import { parseTextBody } from "@/lib/claude/textInput";
import { useState, useEffect, useCallback } from "react";
import { Loader2, SkipForward, ArrowRight, Brain, Compass, RotateCcw, AlertTriangle } from "lucide-react";
import { useTrackStatusWatch } from "@/hooks/useTrackStatusWatch";
import { type LearningGoal } from "@/types";

interface QA {
  question: string;
  answer:   string;
}

interface Props {
  topic:         string;
  endDate:       string;
  /**
   * What the gate said on the way through — set only when the learner named a
   * tool, to say Hugh teaches the thinking behind it rather than the product.
   * Shown here rather than after the track is built: someone who wanted
   * hands-on practice should learn that in the first ten seconds, not the
   * first ten minutes. Empty for almost every topic.
   */
  lensNote?:     string;
  onGoalCreated: (goal: LearningGoal) => void;
  /** Abandon refinement and return the learner to an empty topic form. */
  onReset:       () => void;
  /**
   * Reports what the learner has said so far, for display beside the form.
   *
   * This component stays the owner: the callback carries a projection for
   * rendering, never a second place the flow can be driven from. Must be
   * referentially stable (wrap it in useCallback) or the effect below will
   * fire on every parent render.
   */
  onProgress?:   (p: {
    answers:  QA[];
    question: string | null;
    /** Which half of refinement this is — the diagram beside it lights differently. */
    phase:    "asking" | "building";
  }) => void;
}

const FALLBACK_TIPS = [
  "The best learners tie new concepts to real problems they're already solving.",
  "Teaching what you learn — even to yourself — can accelerate retention by up to 50%.",
  "Short, focused sessions beat marathon study. 25 minutes of deep work outperforms 2 hours of distracted reading.",
];

const MAX_QUESTIONS = 5;

type Phase = "asking" | "waiting" | "failed";

export default function RefinementFlow({ topic, endDate, lensNote, onGoalCreated, onReset, onProgress }: Props) {
  const [question, setQuestion]     = useState<string | null>(null);
  const [answers, setAnswers]       = useState<QA[]>([]);
  const [draft, setDraft]           = useState("");
  const [fetching, setFetching]     = useState(false);
  const [fetchError, setFetchError] = useState(false);

  // Reset is destructive of work the learner can see (their answers) and of
  // the topic behind it, so it asks once before doing it. Only when there is
  // something to lose — an immediate reset on question 1 discards nothing.
  const [confirmingReset, setConfirmingReset] = useState(false);

  const [phase, setPhase]         = useState<Phase>("asking");
  const [tips, setTips]           = useState<string[]>(FALLBACK_TIPS);
  const [tipIdx, setTipIdx]       = useState(0);
  const [pendingGoal, setPendingGoal] = useState<LearningGoal | null>(null);
  // The server's own words when saving the goal fails, not a boolean. A
  // refusal ("that topic sits outside Hugh's focus") and a breakage ("failed to
  // save goal") are different things to the person reading them, and a shared
  // "something went wrong" hides which one happened.
  const [apiError, setApiError]   = useState<string | null>(null);

  // Load first question on mount
  useEffect(() => {
    fetchNextQuestion([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Publish progress for the trail beside the form. Effect rather than a call
  // inside submitAnswer so a question arriving from the server is reported too,
  // not only an answer the learner typed.
  useEffect(() => {
    // 'waiting' and 'failed' both mean the questions are over. Reported as one
    // phase because the diagram is about refinement, and refinement has ended
    // either way — the failure has its own screen to explain itself on.
    onProgress?.({ answers, question, phase: phase === "asking" ? "asking" : "building" });
  }, [answers, question, phase, onProgress]);

  // Tip rotator during waiting
  useEffect(() => {
    if (phase !== "waiting") return;
    const id = setInterval(() => {
      setTipIdx(i => (i + 1) % tips.length);
    }, 5000);
    return () => clearInterval(id);
  }, [phase, tips.length]);

  // Watch the goal's track_status while the track builds (see hook for the
  // Realtime/poll/timeout rationale — shared with DocumentUploadFlow).
  useTrackStatusWatch({
    goalId:   pendingGoal?.id ?? null,
    active:   phase === "waiting",
    onReady:  () => pendingGoal && onGoalCreated({ ...pendingGoal, track_status: "ready" }),
    onFailed: () => setPhase("failed"),
  });

  // Attempt the /refine call, retrying once. Returns the parsed payload, or
  // null if it failed/was malformed after the retry. Note: a 502 from the route
  // does NOT throw, so we must treat !res.ok and missing fields as failures too
  // — otherwise the asking phase hangs on a disabled "thinking…" state forever.
  async function tryRefine(
    currentAnswers: QA[],
  ): Promise<{ question?: string; done?: boolean } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("/api/dashboard/refine", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ topic, answers: currentAnswers }),
        });
        if (!res.ok) continue;
        const data = await res.json() as { question?: string; done?: boolean };
        if (data && (data.question || data.done)) return data;
        // Malformed (neither question nor done) — retry.
      } catch {
        // Network error — retry.
      }
    }
    return null;
  }

  async function fetchNextQuestion(currentAnswers: QA[]) {
    setFetching(true);
    setFetchError(false);

    const data = await tryRefine(currentAnswers);
    setFetching(false);

    if (data?.done) {
      enterWaiting(currentAnswers);
      return;
    }
    if (data?.question) {
      setQuestion(data.question);
      return;
    }

    // Failed after retry. Never leave the user on a disabled "thinking…" state.
    setFetchError(true);
    if (currentAnswers.length > 0) {
      // We already have enough context to refine — don't loop on a broken
      // endpoint; advance straight to the build (Waiting) phase.
      enterWaiting(currentAnswers);
    } else {
      // The very first question failed: offer a generic prompt so the learner
      // can still contribute. Answering it advances answers → MAX terminates.
      setQuestion("What specifically are you hoping to achieve by learning this?");
    }
  }

  const enterWaiting = useCallback(async (finalAnswers: QA[]) => {
    setPhase("waiting");
    setApiError(null);
    setPendingGoal(null);

    try {
      const res  = await fetch("/api/dashboard/goals", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ topic, end_date: endDate, answers: finalAnswers }),
      });
      const data = await res.json() as {
        goal?: LearningGoal; tips?: string[]; error?: string; message?: string;
      };

      if (!res.ok || !data.goal) {
        // Two different failures share this branch, and the learner should be
        // able to tell them apart. A 422 is the server re-gating the refined
        // topic and declining it — a decision, written for a human, and the
        // only useful thing to show. Anything else is a breakage, and the
        // route's own message says more than "something went wrong" does.
        setApiError(
          (res.status === 422 ? data.message : null)
          || data.error
          || "Hugh could not save this goal. Nothing has been lost — try again.",
        );
        setPhase("asking");
        return;
      }

      if (data.tips && data.tips.length > 0) setTips(data.tips);
      // Goal exists with track_status 'pending'; the Realtime effect now waits
      // for the background track build to flip it to 'ready' or 'failed'.
      setPendingGoal(data.goal);
    } catch {
      setApiError("Hugh could not be reached. Your answers are still here — try again.");
      setPhase("asking");
    }
  }, [topic, endDate]);

  async function submitAnswer() {
    const text = draft.trim();
    if (!text || fetching || !question) return;

    const newAnswers = [...answers, { question, answer: text }];
    try {
      parseTextBody("refine", { topic, answers: newAnswers });
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Please shorten your answer.");
      return; // Leave the answer in its editable draft.
    }
    setApiError(null);
    setAnswers(newAnswers);
    setDraft("");
    setQuestion(null);

    if (newAnswers.length >= MAX_QUESTIONS) {
      enterWaiting(newAnswers);
    } else {
      await fetchNextQuestion(newAnswers);
    }
  }

  function handleSkip() {
    enterWaiting(answers);
  }

  function handleResetClick() {
    if (answers.length === 0) onReset();
    else setConfirmingReset(true);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") submitAnswer();
  }

  // ── Failed phase ──────────────────────────────────────────────────────────
  if (phase === "failed") {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15">
            <AlertTriangle size={22} className="text-red-400" />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-slate-100">
              We couldn&apos;t build your track
            </p>
            <p className="mt-1 text-xs text-slate-500 leading-relaxed">
              Your goal is saved to your library — open it to retry generating the track.
            </p>
          </div>
        </div>

        <button
          onClick={() => pendingGoal && onGoalCreated({ ...pendingGoal, track_status: "failed" })}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-900 hover:bg-amber-400 transition-colors"
        >
          Go to my library
          <ArrowRight size={14} />
        </button>
      </div>
    );
  }

  // ── Waiting phase ─────────────────────────────────────────────────────────
  if (phase === "waiting") {
    return (
      <div className="flex flex-col gap-5">
        {/* Building animation */}
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="relative flex h-16 w-16 items-center justify-center">
            <div className="absolute inset-0 animate-ping rounded-full bg-amber-500/20" />
            <div className="absolute inset-2 animate-pulse rounded-full bg-amber-500/10" />
            <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15">
              <Brain size={22} className="text-amber-400" />
            </div>
          </div>

          <div className="text-center">
            <p className="text-sm font-semibold text-slate-100">Building your learning track…</p>
            <p className="mt-0.5 text-xs text-slate-500">This usually takes 1–2 minutes</p>
          </div>

          {/* Indeterminate progress shimmer */}
          <div className="h-1 w-32 overflow-hidden rounded-full bg-slate-700">
            <div className="h-full w-1/3 animate-progress-slide rounded-full bg-amber-500" />
          </div>
        </div>

        {/* Rotating expert tip */}
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-amber-500/70">
            Expert insight
          </p>
          <p
            key={tipIdx}
            className="text-sm text-slate-300 leading-relaxed animate-fadeIn"
          >
            {tips[tipIdx]}
          </p>
        </div>
      </div>
    );
  }

  // ── Asking phase ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      {/* Header row. The confirm replaces it rather than sitting beside it —
          the panel is narrow, and a reset is not something to offer alongside
          the progress dots it is about to clear. */}
      {confirmingReset ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-amber-400/80">
            Discard {answers.length} answer{answers.length === 1 ? "" : "s"} and start over?
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setConfirmingReset(false)}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Keep answering
            </button>
            <button
              onClick={onReset}
              className="flex items-center gap-1 rounded-lg border border-amber-500/40 px-2.5 py-1 text-xs font-semibold text-amber-400 hover:bg-amber-500/10 transition-colors"
            >
              <RotateCcw size={11} />
              Reset
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            onClick={handleResetClick}
            className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-400 transition-colors"
          >
            <RotateCcw size={12} />
            Reset
          </button>

          <div className="flex flex-1 items-center justify-center gap-1.5">
            <span className="text-xs text-slate-600">Refining</span>
            <div className="flex gap-1">
              {Array.from({ length: MAX_QUESTIONS }).map((_, i) => (
                <div
                  key={i}
                  className={`h-1.5 w-1.5 rounded-full transition-all ${
                    i < answers.length ? "bg-amber-500" : "bg-slate-700"
                  }`}
                />
              ))}
            </div>
          </div>

          <button
            onClick={handleSkip}
            className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-400 transition-colors"
          >
            <SkipForward size={12} />
            Skip
          </button>
        </div>
      )}

      {lensNote && (
        <div className="flex items-start gap-2 rounded-xl border border-slate-700/60 bg-slate-800/30 px-3.5 py-2.5">
          <Compass size={13} className="mt-0.5 shrink-0 text-slate-500" />
          <p className="text-xs leading-relaxed text-slate-400">{lensNote}</p>
        </div>
      )}

      {/* Question card */}
      <div className="min-h-[68px] rounded-xl border border-slate-700/60 bg-slate-800/50 p-4">
        {fetching || !question ? (
          <div className="flex items-center gap-2 text-slate-600">
            <Loader2 size={13} className="animate-spin" />
            <span className="text-sm">Hugh is thinking…</span>
          </div>
        ) : (
          <p className="text-sm text-slate-200 leading-relaxed">{question}</p>
        )}
      </div>

      {/* Q1 — the disclosure, at the moment of answering.
          These questions are written to draw out real motivation and
          circumstance, so the answers are the most personal text in the
          product, and since migration 048 they are kept rather than read once
          and discarded. One human line, deliberately not a legal notice: a
          warning under a warm question would thin the very context the store
          exists to capture. It earns its place because the control it points
          at is real - see components/dashboard/GoalAnswers.tsx. */}
      <p className="text-xs leading-relaxed text-slate-600">
        Hugh keeps your answers to shape this track. You can read them back or
        delete them any time from your goal.
      </p>

      {/* Saving the goal failed. The learner is left with a question card that
          will never fill in — nothing is being fetched and nothing is coming —
          so this carries its own way out rather than leaving them to guess
          that the Answer button is now inert. */}
      {apiError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
          <p className="text-xs leading-relaxed text-red-300">{apiError}</p>
          <button
            onClick={() => enterWaiting(answers)}
            className="mt-2 flex items-center gap-1.5 rounded-lg border border-red-400/40 px-2.5 py-1 text-xs font-semibold text-red-200 transition-colors hover:bg-red-500/10"
          >
            <RotateCcw size={11} />
            Try again
          </button>
        </div>
      )}
      {fetchError && (
        <p className="text-xs text-amber-400/80">
          Hugh had trouble reaching the coach — here&apos;s a question to keep going.
        </p>
      )}

      {/* Answer input */}
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={fetching || !question}
        placeholder="Your answer…"
        className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-500 transition-colors disabled:opacity-50"
        autoFocus
      />

      {/* Answer button */}
      <button
        onClick={submitAnswer}
        disabled={!draft.trim() || fetching || !question}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-900 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Answer
        <ArrowRight size={14} />
      </button>

      {/* Footer nudge */}
      <p className="text-center text-xs text-slate-600 leading-relaxed">
        80% of users with a refined goal complete their learning track — skip anytime.
      </p>
    </div>
  );
}
