"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Mic, MicOff, Loader2, Trophy, RotateCcw, AlertCircle, Flag } from "lucide-react";
import ExitLink from "@/components/ui/ExitLink";
import type { TextBodies } from "@/lib/claude/textInput";
import { MIC_PROBLEM_MESSAGE } from "@/lib/mastery/micProblem";
import type { MasteryRecord } from "@/lib/mastery/outcome";
import type { HeldCorrection } from "@/lib/packs/grounding";
import type { MasteryTopic } from "@/lib/mastery/topics";
import { RECENT_LINES } from "@/lib/mastery/turnCheck";
import type { CoverageResponse } from "@/types";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import TopicPanel, { type TopicListState } from "./TopicPanel";

// ── Types ──────────────────────────────────────────────────────────────────

type Phase =
  | "setup"      // the list and how it works
  | "starting"   // the server opening a session
  | "listening"  // the learner's turn: they drive
  | "thinking"   // Hugh checking what they just said
  | "finishing"  // the server adding it up and recording the result
  | "result";    // score + feedback

interface ConversationMessage {
  role: "hugh" | "learner";
  text: string;
}

interface StartReply {
  sessionId: string;
  topics:    MasteryTopic[];
  turnsLeft: number;
}

interface TurnReply {
  reply:     string;
  covered:   string[];
  heldCount: number;
  turnsLeft: number;
}

interface Evaluation {
  score:       number;
  headline:    string;
  /** Labels left open. The panel shows them, so they are only spelled out where it is hidden. */
  missed:      string[];
  /** One per wrong belief left standing. They take turns on screen, so none is cut off. */
  corrections: HeldCorrection[];
  /** What the server scored, so the panel can never disagree with the result. */
  covered:     string[];
  passed:      boolean;
  /** Whether the server recorded it. The score is real either way. */
  record:      MasteryRecord;
}

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
  milestoneId:     string;
  milestoneTitle:  string;
  returnUrl?:      string;
  /** The goal board to use when no returnUrl was supplied. */
  fallbackUrl:     string;
  alreadyMastered: boolean;
  /** Names only. Empty on an older card whose checklist has not been built yet. */
  initialTopics:   MasteryTopic[];
  /** Why this card has no list and cannot get one here. */
  topicsProblem:   string | null;
}

// An older card may not have a checklist yet. The coverage route builds and
// stores one, the same list its Ask page shows.
async function fetchCardTopics(milestoneId: string): Promise<MasteryTopic[]> {
  const res  = await fetch(`/api/tracker/milestones/${milestoneId}/coverage`);
  const data = await res.json().catch(() => ({})) as CoverageResponse;
  if (!res.ok || !data.learningPoints?.length) {
    throw new Error(data.error ?? "Hugh couldn't build this card's list of topics.");
  }
  return data.learningPoints.map(p => ({ ref: p.id, label: p.text }));
}

async function callSession<T>(body: TextBodies["session"]): Promise<T> {
  const res = await fetch("/api/tracker/mastery/session", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as { error?: string }).error ?? `Error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function MasteryClient({ milestoneId, milestoneTitle, returnUrl,
  fallbackUrl, alreadyMastered, initialTopics, topicsProblem }: Props) {
  const router = useRouter();

  // returnUrl carries study-context when the learner came from
  // /study/[goalId]/track. fallbackUrl is that same board, resolved
  // server-side from the track's goal, for anyone arriving here directly.
  const boardUrl = returnUrl ?? fallbackUrl;

  const [phase,      setPhase]      = useState<Phase>("setup");
  const [topics,     setTopics]     = useState<MasteryTopic[]>(initialTopics);
  const [listError,  setListError]  = useState<string | null>(topicsProblem);
  const [sessionId,  setSessionId]  = useState<string | null>(null);
  const [covered,    setCovered]    = useState<string[]>([]);
  const [heldCount,  setHeldCount]  = useState(0);
  const [turnsLeft,  setTurnsLeft]  = useState(0);
  const [messages,   setMessages]   = useState<ConversationMessage[]>([]);
  // Words Hugh could not check. Kept, so a failed turn loses nothing the learner said.
  const [unsent,     setUnsent]     = useState("");
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [correctionAt, setCorrectionAt] = useState(0);
  const [apiError,   setApiError]   = useState<string | null>(null);

  const speech       = useSpeechRecognition();
  const messagesRef  = useRef<ConversationMessage[]>([]);
  const threadEndRef = useRef<HTMLDivElement>(null);

  // Keep ref in sync so async callbacks always see the latest messages
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Hugh's lines are read, not heard, so the newest one has to stay in view. The
  // live transcript is listed because it pushes everything above it upwards.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, phase, speech.transcript]);

  function retryList() {
    setListError(null);
    fetchCardTopics(milestoneId).then(setTopics).catch((e: Error) => setListError(e.message));
  }

  useEffect(() => {
    if (initialTopics.length > 0 || topicsProblem) return;
    fetchCardTopics(milestoneId).then(setTopics).catch((e: Error) => setListError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allDone = topics.length > 0 && covered.length >= topics.length && heldCount === 0;

  // ── Manage speech recognition lifecycle via phase ────────────────────────
  // Do NOT call speech.reset() here — it calls recognition.stop() internally,
  // and calling recognition.start() immediately after causes a race condition
  // where the engine hasn't fully stopped, so start() silently fails.
  // The transcript is already cleared when a turn is sent. With every topic
  // covered there is nothing left to listen for, so the mic stays off.
  useEffect(() => {
    if (phase === "listening" && !allDone) {
      speech.start();
    } else if (speech.isRecording) {
      speech.stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, allDone]);

  // ── Start or restart a session ────────────────────────────────────────────
  // Every attempt starts clean on the server too: a pass is earned in one sitting.
  async function startSession() {
    setMessages([]);
    setCovered([]);
    setHeldCount(0);
    setUnsent("");
    setEvaluation(null);
    setApiError(null);
    speech.reset();  // clear any transcript leftover from a previous session
    setPhase("starting");

    try {
      const data = await callSession<StartReply>({ phase: "start", milestoneId });
      setSessionId(data.sessionId);
      setTopics(data.topics);
      setTurnsLeft(data.turnsLeft);
      setPhase("listening");
    } catch (e) {
      setApiError((e as Error).message);
      setPhase("setup");
    }
  }

  // ── Send what the learner just said ───────────────────────────────────────
  // Returns the reply, or null when it did not get through. The caller decides
  // what follows, so the mic is never reopened just to be closed again.
  async function submitTurn(): Promise<TurnReply | null> {
    const captured = speech.transcript.trim();
    const said     = [unsent, captured].filter(Boolean).join(" ");
    // Nothing caught, so leave the mic open. Stopping it here would leave the
    // screen saying "Listening…" with the mic off: the phase would not change,
    // so nothing would start it again.
    if (!said || !sessionId) return null;

    speech.reset();
    setApiError(null);

    const before  = messagesRef.current;
    const updated = captured ? [...before, { role: "learner" as const, text: captured }] : before;
    setMessages(updated);
    setPhase("thinking");

    // A failed line is already in `said`, so it is left out of the context.
    const context = unsent ? before.slice(0, -1) : before;
    try {
      const data = await callSession<TurnReply>({
        phase: "turn", sessionId, said, recent: context.slice(-RECENT_LINES),
      });
      setUnsent("");
      setCovered(data.covered);
      setHeldCount(data.heldCount);
      setTurnsLeft(data.turnsLeft);
      setMessages([...updated, { role: "hugh", text: data.reply }]);
      return data;
    } catch (e) {
      setUnsent(said);
      setApiError((e as Error).message);
      setPhase("listening");
      return null;
    }
  }

  // ── Add it up: the server scores the ticks it holds and records the result ─
  async function finish() {
    if (!sessionId) return;
    setApiError(null);
    setPhase("finishing");
    try {
      const data = await callSession<Evaluation>({ phase: "finish", sessionId });
      setEvaluation(data);
      setCovered(data.covered);
      setCorrectionAt(0);
    } catch (e) {
      setEvaluation(null);
      setApiError((e as Error).message);
    }
    setPhase("result");
  }

  async function handleDone() {
    const reply = await submitTurn();
    if (!reply) return;
    if (reply.turnsLeft === 0) {
      await finish();
      return;
    }
    setPhase("listening");
  }

  // Someone mid-sentence who presses Finish means to include what they just said.
  async function handleFinish() {
    if (unsent || speech.transcript.trim()) {
      const reply = await submitTurn();
      if (!reply) return;
    }
    await finish();
  }

  // ── Clean exit: stop the mic before navigating ───────────────────────────
  // Runs as the onNavigate of an <ExitLink> (see components/ui/ExitLink), so the
  // teardown happens while the prefetched board is already loading.
  function stopListening() {
    speech.reset();
  }

  // The result is recorded by the server the moment the session is finished
  // (lib/mastery/outcome.ts); this page no longer writes it. So the buttons on
  // the result screen only navigate, and they are shown only when the server
  // reports the result saved. The board celebrates a card arriving with
  // ?mastered=, and that must never fire for a result that was not recorded.
  function navigateBackMastered() {
    const sep = boardUrl.includes("?") ? "&" : "?";
    router.push(`${boardUrl}${sep}mastered=${milestoneId}`);
  }

  // ── Derived values ────────────────────────────────────────────────────────
  const learnerCount = messages.filter(m => m.role === "learner").length;
  const isBusy       = ["starting", "thinking", "finishing"].includes(phase);
  const micOff       = speech.problem !== null || !speech.isSupported;
  const canFinish    = learnerCount > 0 || !!unsent || !!speech.transcript.trim();
  const saveFailed   = evaluation?.record === "failed";
  // On an already-mastered card every practice run is "positive" — mastery is
  // locked, so we never show a fail/almost framing.
  const positive     = alreadyMastered || !!evaluation?.passed;

  const list: TopicListState =
    listError                    ? { kind: "failed", message: listError, onRetry: topicsProblem ? undefined : retryList }
    : topics.length === 0        ? { kind: "building" }
    :                              { kind: "ready" };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen bg-[#0F172A] flex flex-col overflow-hidden">

      {/* Background orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="animate-breathe absolute top-0 right-1/4 h-[500px] w-[500px] -translate-y-1/2 rounded-full bg-violet-500/[0.07] blur-3xl" />
        <div className="animate-breathe-delayed absolute bottom-0 left-1/4 h-[600px] w-[600px] translate-y-1/2 rounded-full bg-sky-500/[0.06] blur-3xl" />
      </div>

      {/* Header */}
      <header className="relative z-10 shrink-0 flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <ExitLink
          href={boardUrl}
          label="Back"
          onNavigate={stopListening}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition-colors"
        />
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Mastery Session</p>
          <p className="mt-0.5 max-w-[280px] truncate text-sm font-semibold text-slate-200">{milestoneTitle}</p>
        </div>
        {/* The count, which is all a screen too narrow for the panel gets, and
            what a screen reader hears as a topic is ticked. */}
        <p aria-live="polite" className="min-w-[3.5rem] text-right text-xs font-semibold text-slate-400">
          {list.kind === "ready" && phase !== "setup" ? `${covered.length} of ${topics.length}` : ""}
        </p>
      </header>

      <main className="relative z-10 flex flex-1 min-h-0 gap-4 px-4 py-4 md:px-6">
        <section className="flex flex-1 min-w-0 min-h-0 flex-col">
          {/* ── SETUP ───────────────────────────────────────────────────────── */}
          {phase === "setup" && (
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-6">
              <div className="w-full max-w-md space-y-6 text-center">
                <div>
                  <h1 className="text-2xl font-bold text-slate-100">
                    {alreadyMastered ? "Practice Your Mastery" : "Profess Your Mastery"}
                  </h1>
                  <p className="mt-3 text-sm text-slate-400 leading-relaxed max-w-sm mx-auto">
                    Explain the topics out loud, in any order and in your own words.{" "}
                    {alreadyMastered
                      ? "This is a practice run — your mastery is already locked in, so explore freely."
                      : <>Cover <span className="text-slate-200 font-semibold">at least 70%</span> of them, with no wrong belief left standing, to confirm mastery.</>}
                  </p>
                </div>
                <div className="rounded-2xl border border-sky-500/30 bg-sky-500/10 px-5 py-4 text-sm text-slate-400 leading-relaxed text-left">
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2">How it works</p>
                  You lead. Your mic opens when you begin. Press Done talking after each point and Hugh checks it against the list, then replies in a line. Hugh won&apos;t bring up the next topic or give you an answer. Press Finish whenever you&apos;re ready.
                </div>
                {apiError && (
                  <p role="alert" className="text-sm text-red-400">{apiError}</p>
                )}
                <button
                  onClick={startSession}
                  disabled={list.kind !== "ready"}
                  className="w-full rounded-2xl border border-sky-500/40 bg-sky-500/10 py-3.5 text-sm font-bold text-sky-300 transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Begin Session
                </button>
              </div>
            </div>
          )}

          {/* ── ACTIVE CONVERSATION ───────────────────────────────────────────── */}
          {!["setup", "result"].includes(phase) && (
            <div className="flex flex-1 flex-col min-h-0">
              {/* Message thread */}
              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
                <div className="max-w-2xl mx-auto space-y-4">

                  {/* Not a real line of Hugh's: it costs nothing and is never sent. */}
                  {messages.length === 0 && phase === "listening" && (
                    <div className="flex gap-3 max-w-[85%]">
                      <div className="shrink-0 mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-slate-300">
                        H
                      </div>
                      <div className="rounded-2xl rounded-tl-sm border border-slate-700/60 bg-slate-800/60 px-4 py-3">
                        <p className="text-sm text-slate-200 leading-relaxed">Start wherever you like. I&apos;m listening.</p>
                      </div>
                    </div>
                  )}

                  {/* Announces each new line to a screen reader, now that Hugh makes
                      no sound. The live transcript stays outside: announcing every
                      word as it forms would talk over the learner. */}
                  <div aria-live="polite" className="space-y-4">
                  {messages.map((msg, i) =>
                    msg.role === "hugh" ? (
                      <div key={i} className="flex gap-3 max-w-[85%]">
                        <div className="shrink-0 mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-slate-300">
                          H
                        </div>
                        <div className="rounded-2xl rounded-tl-sm border border-slate-700/60 bg-slate-800/60 px-4 py-3">
                          <p className="text-sm text-slate-200 leading-relaxed">{msg.text}</p>
                        </div>
                      </div>
                    ) : (
                      <div key={i} className="flex gap-3 max-w-[85%] ml-auto flex-row-reverse">
                        <div className="shrink-0 mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-sky-900/60 text-xs font-bold text-sky-300">
                          Y
                        </div>
                        <div className="rounded-2xl rounded-tr-sm border border-sky-800/40 bg-sky-900/30 px-4 py-3">
                          <p className="text-sm text-slate-200 leading-relaxed">{msg.text}</p>
                        </div>
                      </div>
                    )
                  )}
                  </div>

                  {/* Live transcript while the user is recording */}
                  {phase === "listening" && !allDone && (
                    <div className="flex gap-3 max-w-[85%] ml-auto flex-row-reverse">
                      <div className="shrink-0 mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-sky-900/60 text-xs font-bold text-sky-300">
                        Y
                      </div>
                      <div className="rounded-2xl rounded-tr-sm border border-sky-700/50 bg-sky-900/40 px-4 py-3 min-w-[120px]">
                        {speech.transcript ? (
                          <p className="text-sm text-slate-200 leading-relaxed">{speech.transcript}</p>
                        ) : (
                          <p className="text-sm text-slate-500 italic">{micOff ? "Your mic is off." : "Listening…"}</p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Spinner states */}
                  {isBusy && (
                    <div className="flex items-center gap-2 text-xs text-slate-500 px-1 py-2">
                      <Loader2 size={12} className="animate-spin" />
                      {phase === "starting"  && "Getting your session ready…"}
                      {phase === "thinking"  && "Hugh is checking that…"}
                      {phase === "finishing" && "Hugh is adding it up…"}
                    </div>
                  )}

                  <div ref={threadEndRef} />

                </div>
              </div>

              {/* Bottom mic area */}
              <div className="shrink-0 border-t border-slate-800/60 px-6 py-5">
                <div className="max-w-2xl mx-auto flex flex-col items-center gap-4">

                  {/* A turn Hugh could not check, and a mic that stopped, each get
                      their own copy and their own way out (rule 5): both would
                      otherwise sit behind "Listening…" with nothing to tell them
                      from a wait. What the learner said is kept for the retry. */}
                  {phase === "listening" && apiError && (
                    <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
                      <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                      <div className="space-y-2">
                        <p className="text-sm text-red-300">{apiError} What you said is kept.</p>
                        <button
                          onClick={handleDone}
                          className="flex items-center gap-1.5 text-xs font-semibold text-red-200 hover:text-red-100 transition-colors"
                        >
                          <RotateCcw size={12} />
                          Try again
                        </button>
                      </div>
                    </div>
                  )}
                  {phase === "listening" && !allDone && speech.problem && (
                    <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
                      <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                      <div className="space-y-2">
                        <p className="text-sm text-red-300">{MIC_PROBLEM_MESSAGE[speech.problem]}</p>
                        <button
                          onClick={speech.start}
                          className="flex items-center gap-1.5 text-xs font-semibold text-red-200 hover:text-red-100 transition-colors"
                        >
                          <RotateCcw size={12} />
                          Try the mic again
                        </button>
                      </div>
                    </div>
                  )}

                  {phase === "listening" && allDone && (
                    <p className="text-sm font-semibold text-green-300">Every topic is covered.</p>
                  )}
                  {phase === "listening" && !allDone && turnsLeft > 0 && turnsLeft <= 3 && (
                    <p className="text-xs text-amber-300">
                      {turnsLeft === 1 ? "1 turn left" : `${turnsLeft} turns left`}. The session finishes itself after that.
                    </p>
                  )}

                  {phase === "listening" && (
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      {!allDone && !micOff && (
                        <div className="relative mr-2 flex items-center justify-center">
                          <div className="absolute h-12 w-12 rounded-full bg-red-500/20 animate-ping" />
                          <div className="relative flex h-10 w-10 items-center justify-center rounded-full border border-red-500/50 bg-red-500/20">
                            <Mic size={18} className="text-red-400" />
                          </div>
                        </div>
                      )}
                      {!allDone && (
                        <button
                          onClick={handleDone}
                          className="flex items-center gap-2 rounded-xl bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 transition-colors"
                        >
                          <MicOff size={15} />
                          Done talking
                        </button>
                      )}
                      <button
                        onClick={handleFinish}
                        disabled={!canFinish}
                        title={canFinish ? undefined : "Say something first, so Hugh has something to check."}
                        className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          allDone
                            ? "bg-green-600 text-white hover:bg-green-500"
                            : "border border-slate-700 text-slate-300 hover:border-slate-600 hover:text-slate-100"
                        }`}
                      >
                        <Flag size={15} />
                        Finish
                      </button>
                    </div>
                  )}
                  {phase === "listening" && !allDone && !speech.isSupported && (
                    <p className="text-xs text-red-400">Chrome or Edge required for voice input</p>
                  )}

                  {/* End session — always visible during active conversation */}
                  <ExitLink
                    href={boardUrl}
                    label="End session & take a break"
                    onNavigate={stopListening}
                    showIcon={false}
                    iconSize={12}
                    className="inline-flex items-center gap-1.5 text-xs text-slate-700 hover:text-slate-500 transition-colors"
                  />

                </div>
              </div>
            </div>
          )}

          {/* ── RESULT ────────────────────────────────────────────────────────── */}
          {phase === "result" && (
            <div className="flex flex-1 flex-col items-center justify-center px-2 py-2 md:px-4">
              <div className="w-full max-w-xl space-y-2.5">

                {evaluation && (
                  <>
                    {/* Score card */}
                    <div className={`flex items-center justify-center gap-4 rounded-2xl border px-5 py-3 ${
                      positive
                        ? "border-green-500/30 bg-green-500/5"
                        : "border-amber-500/30 bg-amber-500/5"
                    }`}>
                      <div className={`text-4xl font-black ${positive ? "text-green-300" : "text-amber-300"}`}>
                        {evaluation.score}
                        <span className="text-xl font-normal text-slate-500">/10</span>
                      </div>
                      <p className={`text-sm font-semibold ${positive ? "text-green-400" : "text-amber-400"}`}>
                        {saveFailed
                          ? "Scored, but not saved"
                          : alreadyMastered
                          ? "Still mastered — practice logged"
                          : evaluation.passed
                          ? "Mastery confirmed"
                          : "Not yet"}
                      </p>
                    </div>

                    {/* This screen cannot scroll (Rule 4). The list of what is open lives in
                        the panel beside it, and corrections take turns rather than stack. */}
                    <div className="rounded-2xl border border-slate-700/60 bg-slate-800/40 px-5 py-3.5">
                      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">Where you got to</p>
                      <p className="text-sm text-slate-300 leading-relaxed">{evaluation.headline}</p>
                      {evaluation.missed.length > 0 && evaluation.corrections.length === 0 && (
                        <p className="mt-1.5 text-sm text-slate-400 leading-relaxed md:hidden">
                          Not covered: {evaluation.missed.join("; ")}.
                        </p>
                      )}
                      {evaluation.corrections.length > 0 && (
                        <div className="mt-2.5 border-t border-slate-700/60 pt-2.5">
                          <p className="text-sm text-amber-100/90 leading-relaxed">
                            {evaluation.corrections[correctionAt]?.lead} {evaluation.corrections[correctionAt]?.correction}{" "}
                            <a
                              href={evaluation.corrections[correctionAt]?.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="whitespace-nowrap text-amber-300 underline underline-offset-2 hover:text-amber-200"
                            >
                              Source
                            </a>
                            <span className="text-slate-500"> · {evaluation.corrections[correctionAt]?.sourceName}</span>
                          </p>
                          {evaluation.corrections.length > 1 && (
                            <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                              <span className="text-slate-500">
                                Correction {correctionAt + 1} of {evaluation.corrections.length}
                              </span>
                              <button
                                onClick={() => setCorrectionAt(i => (i + 1) % evaluation.corrections.length)}
                                className="font-semibold text-amber-300 transition-colors hover:text-amber-200"
                              >
                                Next
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* The ticks are safe on the server, so a failure here never means
                    repeating the session. Pressing again adds them up and records
                    them afresh (rule 5). */}
                {!evaluation && (
                  <div role="alert" className="space-y-2.5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3.5">
                    <div className="flex items-start gap-2.5">
                      <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                      <p className="text-sm text-red-300">
                        {apiError ?? "Hugh couldn't add up this session."} Your ticks are safe.
                      </p>
                    </div>
                    <button
                      onClick={finish}
                      className="w-full flex items-center justify-center gap-2 rounded-xl bg-red-500/20 py-2.5 text-sm font-semibold text-red-200 hover:bg-red-500/30 transition-colors"
                    >
                      <RotateCcw size={14} />
                      Try again
                    </button>
                    <ExitLink
                      href={boardUrl}
                      label="Back to board"
                      onNavigate={stopListening}
                      showIcon={false}
                      className="block w-full rounded-xl border border-red-500/30 py-2 text-center text-xs text-red-300/80 hover:text-red-200 hover:border-red-500/50 transition-colors"
                    />
                  </div>
                )}

                {/* CTA. Every button but the save retry only navigates, because
                    the server has already recorded the result. */}
                {evaluation && (saveFailed ? (
                  <div className="space-y-2.5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3">
                    <div className="flex items-start gap-2.5">
                      <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                      <p className="text-sm text-red-300">
                        Hugh added this up but couldn&apos;t save the result. Your score above is real, and saving it doesn&apos;t mean repeating anything.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={finish}
                        className="w-full flex items-center justify-center gap-2 rounded-xl bg-red-500/20 py-2.5 text-sm font-semibold text-red-200 hover:bg-red-500/30 transition-colors"
                      >
                        <RotateCcw size={14} />
                        Try saving again
                      </button>
                      <ExitLink
                        href={boardUrl}
                        label="Back without saving"
                        onNavigate={stopListening}
                        showIcon={false}
                        className="flex items-center justify-center rounded-xl border border-red-500/30 py-2.5 text-center text-xs text-red-300/80 hover:text-red-200 hover:border-red-500/50 transition-colors"
                      />
                    </div>
                  </div>
                ) : alreadyMastered ? (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={navigateBackMastered}
                      className="w-full flex items-center justify-center gap-2 rounded-2xl bg-green-600 py-3 text-sm font-bold text-white hover:bg-green-500 transition-colors"
                    >
                      <Trophy size={16} />
                      Finish
                    </button>
                    <button
                      onClick={startSession}
                      className="w-full flex items-center justify-center gap-2 rounded-2xl border border-slate-700 py-3 text-sm text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
                    >
                      <RotateCcw size={14} />
                      Practice again
                    </button>
                  </div>
                ) : evaluation.passed ? (
                  <button
                    onClick={navigateBackMastered}
                    className="w-full flex items-center justify-center gap-2 rounded-2xl bg-green-600 py-3.5 text-sm font-bold text-white hover:bg-green-500 transition-colors"
                  >
                    <Trophy size={16} />
                    Continue
                  </button>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={startSession}
                      className="w-full flex items-center justify-center gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 py-3 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 transition-colors"
                    >
                      <RotateCcw size={14} />
                      Start over
                    </button>
                    <ExitLink
                      href={boardUrl}
                      label="Back to board"
                      onNavigate={stopListening}
                      showIcon={false}
                      className="block w-full rounded-2xl border border-slate-700 py-3 text-center text-sm text-slate-500 hover:text-slate-300 hover:border-slate-600 transition-colors"
                    />
                  </div>
                ))}

              </div>
            </div>
          )}
        </section>

        {/* The checklist beside the conversation. It sits outside the phases so
            it stays mounted. Its width is what lets the longest card fit: narrower,
            and most labels wrap (TopicPanel). */}
        <aside className="hidden md:block w-80 shrink-0 min-h-0">
          <TopicPanel topics={topics} covered={covered} heldCount={heldCount} list={list} />
        </aside>
      </main>

    </div>
  );
}
