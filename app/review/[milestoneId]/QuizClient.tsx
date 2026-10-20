"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, Timer, CheckCircle2, XCircle,
  Trophy, RefreshCcw, AlertCircle, ChevronRight,
} from "lucide-react";
import ExitLink from "@/components/ui/ExitLink";
import {
  outcomeOfStatus, outcomeOfThrown,
  type SaveOutcome, type SaveFailure,
} from "@/lib/errors/saveOutcome";
import type { PublicQuestion, AnswerReveal, ReviewRecord } from "@/lib/tracker/reviewGrading";

/** What tracker/review/submit decided. The browser no longer grades anything. */
interface SubmitResult {
  total:   number;
  correct: number;
  passed:  boolean;
  record:  ReviewRecord;
}

// "grading": the server is checking the locked answers. "validating": the
// server says it passed but the card could not be marked — see submitQuiz.
type Phase = "idle" | "generating" | "quiz" | "grading" | "results" | "validating";

interface Props {
  milestoneId:    string;
  milestoneTitle: string;
  entryCount:     number;
  returnUrl:      string;
}

const SECONDS_PER_Q = 45;
const OPTION_LABELS = ["A", "B", "C", "D"] as const;

export default function QuizClient({ milestoneId, milestoneTitle, entryCount, returnUrl }: Props) {
  const router = useRouter();

  const [phase, setPhase]           = useState<Phase>("idle");
  const [quizId, setQuizId]         = useState<string | null>(null);
  const [questions, setQuestions]   = useState<PublicQuestion[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  // The answer being locked for the current question; `choice` null is a
  // question whose timer ran out. Cleared when the next question opens.
  const [pending, setPending]       = useState<{ choice: number | null } | null>(null);
  const [answering, setAnswering]   = useState(false);
  // The server's verdict per question, sent only once that answer is locked.
  const [reveals, setReveals]       = useState<(AnswerReveal | null)[]>([]);
  const [timeLeft, setTimeLeft]     = useState(SECONDS_PER_Q);
  const [genError, setGenError]     = useState<string | null>(null);
  // An answer that could not be locked. The question stays open to retry it.
  const [answerFailure, setAnswerFailure] = useState<SaveFailure | null>(null);
  const [grade, setGrade]           = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Grading, or saving a pass, did not go through — see submitQuiz.
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reveal   = reveals[currentIdx] ?? null;
  const revealed = reveal !== null;

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    setTimeLeft(SECONDS_PER_Q);
    timerRef.current = setInterval(() => {
      setTimeLeft(t => (t <= 1 ? 0 : t - 1));
    }, 1000);
  }, [clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  /**
   * Lock this question's answer on the server, then show its key.
   *
   * The key is not in the browser until this returns: the server stores the
   * answer first and only then reveals, and it never accepts a second answer
   * to the same question. A retry therefore resends the same choice, and if
   * the first attempt did land, the server answers with what it locked.
   */
  const lockAnswer = useCallback(async (choice: number | null) => {
    if (!quizId) return;
    clearTimer();
    setPending({ choice });
    setAnswering(true);
    setAnswerFailure(null);

    const questionIndex = currentIdx;
    let outcome: SaveOutcome;
    try {
      const res = await fetch("/api/tracker/review/answer", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ quizId, questionIndex, choice }),
      });
      outcome = outcomeOfStatus(res.status);
      if (outcome.ok) {
        const locked = await res.json() as AnswerReveal;
        setReveals(prev => {
          const next = [...prev];
          next[questionIndex] = locked;
          return next;
        });
      }
    } catch (err) {
      outcome = outcomeOfThrown(err);
    }

    if (!outcome.ok) setAnswerFailure(outcome);
    setAnswering(false);
  }, [quizId, currentIdx, clearTimer]);

  // When the timer hits 0, lock "no answer" — it counts as wrong. Reacting to
  // the ticking timer is the intent here, so a state update from the effect is.
  useEffect(() => {
    if (timeLeft === 0 && phase === "quiz" && !revealed && pending === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void lockAnswer(null);
    }
  }, [timeLeft, phase, revealed, pending, lockAnswer]);

  async function handleStart() {
    setGenError(null);
    setPhase("generating");
    try {
      const res = await fetch("/api/tracker/review/quiz", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ milestoneId }),
      });
      const d = await res.json() as { quizId?: string; questions?: PublicQuestion[]; error?: string };
      if (!res.ok || !d.questions || !d.quizId) {
        setGenError(d.error ?? "Failed to generate quiz. Please try again.");
        setPhase("idle");
        return;
      }
      setQuizId(d.quizId);
      setQuestions(d.questions);
      setReveals([]);
      setCurrentIdx(0);
      setPending(null);
      setAnswerFailure(null);
      setGrade(null);
      setSaveFailure(null);
      setPhase("quiz");
      startTimer();
    } catch {
      setGenError("Network error. Please check your connection and try again.");
      setPhase("idle");
    }
  }

  function handleSelect(idx: number) {
    if (revealed || pending !== null) return;
    void lockAnswer(idx);
  }

  /**
   * Ask the server to grade the locked answers, and record a pass.
   *
   * The server decides pass or fail now; the browser only learns the verdict.
   * Three different things can come back, and each reads differently (rule 5):
   * grading never happened (stay here, try again); it passed but the card could
   * not be marked (the pass stands — "Try saving again" is this same call,
   * because the answers are locked and the grade cannot change); or it was
   * graded and saved. Only the last may leave this screen, and `fetch` resolves
   * for a 401 exactly as it does for a 200, so the status is read, not assumed.
   */
  async function submitQuiz() {
    if (!quizId) return;
    setSaveFailure(null);
    setSubmitting(true);

    let outcome: SaveOutcome;
    let result: SubmitResult | null = null;
    try {
      const res = await fetch("/api/tracker/review/submit", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ quizId, milestoneId }),
      });
      outcome = outcomeOfStatus(res.status);
      if (outcome.ok) result = await res.json() as SubmitResult;
    } catch (err) {
      outcome = outcomeOfThrown(err);
    }
    setSubmitting(false);

    if (!outcome.ok) {
      setSaveFailure(outcome);
      return;
    }
    if (!result) return;
    setGrade(result);

    if (!result.passed) {
      setPhase("results");
      return;
    }
    if (result.record !== "saved") {
      // Graded and passed, but the server could not mark the card.
      const notSaved = outcomeOfStatus(500);
      if (!notSaved.ok) setSaveFailure(notSaved);
      setPhase("validating");
      return;
    }

    // Append validated flag so the board can show the celebration
    const sep  = returnUrl.includes("?") ? "&" : "?";
    router.push(`${returnUrl}${sep}validated=${milestoneId}`);
  }

  function handleNext() {
    if (currentIdx + 1 >= questions.length) {
      setPhase("grading");
      void submitQuiz();
      return;
    }

    setCurrentIdx(i => i + 1);
    setPending(null);
    setAnswerFailure(null);
    startTimer();
  }

  const q          = questions[currentIdx];
  const timerPct   = (timeLeft / SECONDS_PER_Q) * 100;
  const timerColor = timeLeft > 15 ? "bg-sky-500" : timeLeft > 7 ? "bg-amber-500" : "bg-red-500";

  // ─── Idle / entry-count gate ───────────────────────────────────────────────
  if (phase === "idle") {
    return (
      <div className="min-h-screen bg-[#0F172A] flex flex-col">
        <header className="shrink-0 flex items-center gap-4 border-b border-slate-800 px-6 py-4">
          <ExitLink
            href={returnUrl}
            label="Back to board"
            iconSize={15}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          />
        </header>

        <div className="flex flex-1 items-center justify-center px-6 py-12">
          <div className="w-full max-w-lg text-center">
            <div className="mb-6 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-400">
              <Timer size={26} />
            </div>
            <h1 className="mb-1 text-2xl font-bold text-slate-100">Review Quiz</h1>
            <p className="mb-8 text-sm text-slate-400">{milestoneTitle}</p>

            <div className="mb-8 rounded-2xl border border-slate-700/60 bg-slate-800/50 px-6 py-4 text-left space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1">How it works</p>
              {([
                ["2 to 5 questions", "however many your diary entries for this card genuinely support"],
                ["Grounded in your notes", "every question quotes the line it came from — nothing from outside"],
                ["45 seconds each", "answer before time runs out or it counts as wrong"],
                ["All correct", "required to officially mark this card as reviewed"],
                ["Unlimited retries", "each attempt generates fresh questions — no memorising"],
              ] as const).map(([bold, rest]) => (
                <div key={bold} className="flex items-start gap-3">
                  <ChevronRight size={14} className="mt-0.5 shrink-0 text-amber-400" />
                  <p className="text-sm text-slate-300">
                    <span className="font-semibold text-slate-100">{bold}</span>{" — "}{rest}
                  </p>
                </div>
              ))}
            </div>

            {genError && (
              <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-left">
                <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                <p className="text-sm text-red-300">{genError}</p>
              </div>
            )}

            {entryCount === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-800/60 px-5 py-4">
                <p className="text-sm text-slate-400 leading-relaxed">
                  No learning diary entries found for this milestone.
                  <br />
                  Add entries via Ask Hugh or the learning diary before starting the quiz.
                </p>
              </div>
            ) : (
              <>
                <p className="mb-4 text-xs text-slate-500">
                  {entryCount} learning {entryCount === 1 ? "entry" : "entries"} available
                </p>
                <button
                  onClick={handleStart}
                  className="w-full rounded-xl bg-amber-600 px-6 py-3.5 text-base font-semibold text-white hover:bg-amber-500 transition-colors"
                >
                  Start Quiz
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── Generating questions ─────────────────────────────────────────────────
  if (phase === "generating") {
    return (
      <div className="min-h-screen bg-[#0F172A] flex items-center justify-center">
        <div className="text-center">
          <Loader2 size={32} className="animate-spin text-amber-400 mx-auto mb-4" />
          <p className="text-sm text-slate-400">Generating your personalised quiz…</p>
          <p className="mt-1 text-xs text-slate-600">Analysing your learning diary entries</p>
        </div>
      </div>
    );
  }

  // ─── Active question ──────────────────────────────────────────────────────
  if (phase === "quiz" && q) {
    // The locked choice once the server has it; until then, the one in flight.
    const chosen    = reveal ? reveal.choice : pending?.choice ?? null;
    const isCorrect = reveal?.correct ?? false;

    return (
      <div className="min-h-screen bg-[#0F172A] flex flex-col">
        <header className="shrink-0 border-b border-slate-800 px-6 py-4">
          <div className="mx-auto max-w-2xl flex items-center justify-between">
            <ExitLink
              href={returnUrl}
              label="Quit"
              onNavigate={clearTimer}
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition-colors"
            />
            <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              Question {currentIdx + 1} / {questions.length}
            </span>
            <div className={`flex items-center gap-1.5 text-sm font-mono font-bold tabular-nums ${
              timeLeft > 15 ? "text-slate-400" : timeLeft > 7 ? "text-amber-400" : "text-red-400"
            }`}>
              <Timer size={13} />
              {timeLeft}s
            </div>
          </div>

          {/* Question progress dots */}
          <div className="mx-auto max-w-2xl mt-3 flex gap-1">
            {questions.map((_, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i < currentIdx  ? "bg-green-500"
                  : i === currentIdx ? "bg-amber-500"
                  : "bg-slate-700"
                }`}
              />
            ))}
          </div>

          {/* Timer bar */}
          <div className="mx-auto max-w-2xl mt-2 h-0.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-1000 ease-linear ${timerColor}`}
              style={{ width: `${timerPct}%` }}
            />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto max-w-2xl">
            <p className="mb-8 text-xl font-semibold text-slate-100 leading-relaxed">
              {q.question}
            </p>

            <div className="space-y-3">
              {q.options.map((opt, idx) => {
                let btnStyle: string;
                if (!reveal) {
                  btnStyle = pending === null
                    ? "border-slate-700 bg-slate-800/60 text-slate-200 hover:border-slate-500 hover:bg-slate-800 cursor-pointer"
                    : idx === chosen
                      ? "border-sky-500/70 bg-sky-900/30 text-sky-200 cursor-default"
                      : "border-slate-700/30 bg-slate-800/20 text-slate-500 cursor-default";
                } else if (idx === reveal.correctIndex) {
                  btnStyle = "border-green-500/70 bg-green-900/30 text-green-200 cursor-default";
                } else if (idx === chosen) {
                  btnStyle = "border-red-500/70 bg-red-900/30 text-red-300 cursor-default";
                } else {
                  btnStyle = "border-slate-700/30 bg-slate-800/20 text-slate-600 cursor-default";
                }

                return (
                  <button
                    key={idx}
                    onClick={() => handleSelect(idx)}
                    disabled={revealed || pending !== null}
                    className={`w-full flex items-start gap-4 rounded-xl border px-4 py-4 text-left transition-all duration-150 ${btnStyle}`}
                  >
                    <span className={`mt-0.5 shrink-0 flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold
                      ${reveal && idx === reveal.correctIndex ? "bg-green-500 text-white"
                        : reveal && idx === chosen && idx !== reveal.correctIndex ? "bg-red-500 text-white"
                        : "bg-slate-700 text-slate-400"}`}
                    >
                      {OPTION_LABELS[idx]}
                    </span>
                    <span className="flex-1 text-sm leading-relaxed">{opt}</span>
                    {reveal && idx === reveal.correctIndex && (
                      <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-400" />
                    )}
                    {reveal && idx === chosen && idx !== reveal.correctIndex && (
                      <XCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Locking the answer. Brief, but never silent. */}
            {answering && (
              <div className="mt-6 flex items-center justify-center gap-2 text-sm text-slate-500">
                <Loader2 size={14} className="animate-spin" />
                Checking your answer…
              </div>
            )}

            {/* The answer did not lock, so there is nothing to reveal yet. The
                same choice is resent; if it had landed, the server says so. */}
            {answerFailure && !answering && !reveal && (
              <div className="mt-6 animate-fadeIn">
                <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-left">
                  <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                  <p className="text-sm text-red-300">{answerFailure.message}</p>
                </div>
                {answerFailure.canRetry && pending && (
                  <button
                    onClick={() => void lockAnswer(pending.choice)}
                    className="w-full flex items-center justify-center gap-2 rounded-xl bg-slate-700 px-6 py-3 text-sm font-semibold text-slate-100 hover:bg-slate-600 transition-colors"
                  >
                    <RefreshCcw size={14} />
                    Try again
                  </button>
                )}
              </div>
            )}

            {/* Explanation + next button — only after the answer is locked */}
            {reveal && (
              <div className="mt-6 animate-fadeIn">
                <div className={`mb-4 rounded-xl border px-4 py-3.5 ${
                  chosen === null ? "border-amber-500/30 bg-amber-900/20"
                  : isCorrect    ? "border-green-500/30 bg-green-900/20"
                  :                "border-red-500/30 bg-red-900/20"
                }`}>
                  <p className={`mb-1 text-sm font-semibold ${
                    chosen === null ? "text-amber-300" : isCorrect ? "text-green-300" : "text-red-300"
                  }`}>
                    {chosen === null ? "⏱ Time's up!" : isCorrect ? "✓ Correct!" : "✗ Incorrect"}
                  </p>
                  <p className="text-sm text-slate-300 leading-relaxed">{reveal.explanation}</p>
                </div>

                {/* The line from your own diary this question rests on. Shown so a
                    question can always be traced back — if it can't be, it was
                    dropped server-side before you ever saw it. */}
                {reveal.source && (
                  <div className="mb-4 rounded-xl border border-slate-700/60 bg-slate-800/40 px-4 py-3">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                      From your notes
                    </p>
                    <p className="text-xs italic leading-relaxed text-slate-400">“{reveal.source}”</p>
                  </div>
                )}

                <button
                  onClick={handleNext}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-slate-700 px-6 py-3 text-sm font-semibold text-slate-100 hover:bg-slate-600 transition-colors"
                >
                  {currentIdx + 1 >= questions.length ? "See results" : "Next question"}
                  <ChevronRight size={15} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── Grading (the server is checking the locked answers) ──────────────────
  // A wait and a failure read differently (rule 5). This failure was never
  // graded at all, so it says so and offers the same call again — the answers
  // are locked on the server, so retrying cannot change the result.
  if (phase === "grading") {
    return (
      <div className="min-h-screen bg-[#0F172A] flex items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          {saveFailure && !submitting ? (
            <>
              <div className="mb-5 inline-flex h-16 w-16 items-center justify-center rounded-full bg-red-500/15 text-red-400">
                <AlertCircle size={30} />
              </div>
              <h2 className="mb-2 text-2xl font-bold text-slate-100">We couldn&apos;t check your answers</h2>
              <p className="mb-4 text-sm text-slate-400">
                Your answers are kept. Trying again checks the same answers — nothing about the quiz changes.
              </p>
              <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-left">
                <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                <p className="text-sm text-red-300">{saveFailure.message}</p>
              </div>
              <div className="flex flex-col gap-2">
                {saveFailure.canRetry && (
                  <button
                    onClick={() => void submitQuiz()}
                    className="flex items-center justify-center gap-2 rounded-xl bg-amber-600 py-3 text-sm font-bold text-white hover:bg-amber-500 transition-colors"
                  >
                    <RefreshCcw size={14} />
                    Try again
                  </button>
                )}
                <ExitLink
                  href={returnUrl}
                  label="Back to board"
                  className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 py-2.5 text-sm text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
                />
              </div>
            </>
          ) : (
            <>
              <Loader2 size={32} className="animate-spin text-amber-400 mx-auto mb-4" />
              <p className="text-sm text-slate-400">Checking your answers…</p>
            </>
          )}
        </div>
      </div>
    );
  }

  // ─── Validating (passed — but the card could not be marked) ──────────────
  // The score stays on screen: the learner did pass, and the server said so.
  // Only the line underneath changes, from a wait into a failure with its own
  // way out (rule 5).
  if (phase === "validating") {
    return (
      <div className="min-h-screen bg-[#0F172A] flex items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <div className="mb-5 inline-flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20 text-green-400">
            <Trophy size={30} />
          </div>
          <h2 className="mb-2 text-2xl font-bold text-slate-100">Quiz Passed!</h2>
          <p className="mb-1 text-4xl font-black text-green-400">
            {grade?.correct ?? questions.length} / {grade?.total ?? questions.length}
          </p>

          {saveFailure && !submitting ? (
            <>
              <p className="mb-4 text-sm text-slate-400">
                Your score stands. It is marking the card as reviewed that didn&apos;t go through.
              </p>
              <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-left">
                <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                <p className="text-sm text-red-300">{saveFailure.message}</p>
              </div>
              <div className="flex flex-col gap-2">
                {saveFailure.canRetry && (
                  <button
                    onClick={() => void submitQuiz()}
                    className="flex items-center justify-center gap-2 rounded-xl bg-green-600 py-3 text-sm font-bold text-white hover:bg-green-500 transition-colors"
                  >
                    <RefreshCcw size={14} />
                    Try saving again
                  </button>
                )}
                <ExitLink
                  href={returnUrl}
                  label="Back to board without saving"
                  className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 py-2.5 text-sm text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
                />
              </div>
            </>
          ) : (
            <>
              <p className="mb-6 text-sm text-slate-400">All correct — marking this card as reviewed…</p>
              <div className="flex items-center justify-center gap-2 text-sm text-slate-500">
                <Loader2 size={14} className="animate-spin" />
                Saving and returning to your board…
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ─── Results (failed) ─────────────────────────────────────────────────────
  if (phase === "results") {
    const finalCorrect = grade?.correct ?? 0;
    const finalTotal   = grade?.total ?? questions.length;

    return (
      <div className="min-h-screen bg-[#0F172A] flex flex-col">
        <header className="shrink-0 border-b border-slate-800 px-6 py-4">
          <div className="mx-auto max-w-2xl">
            <ExitLink
              href={returnUrl}
              label="Back to board"
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition-colors"
            />
          </div>
        </header>

        <div className="flex flex-1 items-center justify-center px-6 py-12">
          <div className="w-full max-w-lg text-center">
            <div className="mb-6 inline-flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/20 text-amber-400">
              <XCircle size={30} />
            </div>
            <h2 className="mb-2 text-2xl font-bold text-slate-100">Almost there</h2>
            <p className="mb-1 text-4xl font-black text-amber-400">
              {finalCorrect} / {finalTotal}
            </p>
            <p className="mb-8 text-sm text-slate-400">
              You need all {finalTotal} correct to pass. Review your notes and give it another go.
            </p>

            {/* Per-question breakdown */}
            <div className="mb-8 rounded-2xl border border-slate-700/60 bg-slate-800/50 px-4 py-4 text-left space-y-2.5">
              {questions.map((qItem, i) => {
                const correct = reveals[i]?.correct ?? false;
                return (
                  <div key={i} className="flex items-center gap-3">
                    {correct
                      ? <CheckCircle2 size={14} className="shrink-0 text-green-400" />
                      : <XCircle      size={14} className="shrink-0 text-red-400"   />
                    }
                    <p className="text-xs text-slate-400 truncate flex-1 min-w-0">{qItem.question}</p>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-3">
              <ExitLink
                href={returnUrl}
                label="Back to board"
                className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-300 hover:bg-slate-700 transition-colors"
              />
              <button
                onClick={handleStart}
                className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-3 text-sm font-semibold text-white hover:bg-amber-500 transition-colors"
              >
                <RefreshCcw size={14} />
                Retry Quiz
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
