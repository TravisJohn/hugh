"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Briefcase, Users, MessageCircle, GraduationCap,
  Mic, MicOff, Loader2, Trophy, RotateCcw, AlertCircle,
} from "lucide-react";
import ExitLink from "@/components/ui/ExitLink";
import type { MasteryRecord } from "@/lib/mastery/outcome";
import { useAudioPlayer } from "@/hooks/useAudioPlayer";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";

// ── Types ──────────────────────────────────────────────────────────────────

type ScenarioKey = "interview" | "client" | "huddle" | "teaching";

type Phase =
  | "setup"       // scenario selection / confirmation
  | "generating"  // fetching Hugh's opener
  | "playing"     // Hugh's audio is playing
  | "listening"   // user's turn to speak
  | "thinking"    // fetching Hugh's next response
  | "evaluating"  // Claude scoring the conversation (the server records it)
  | "result";     // show score + feedback

interface ConversationMessage {
  role: "hugh" | "learner";
  text: string;
}

interface Evaluation {
  score:    number;
  feedback: string;
  passed:   boolean;
  /** Whether the server recorded it. The score is real either way. */
  record:   MasteryRecord;
}

// ── Scenario config ────────────────────────────────────────────────────────

const SCENARIOS: Record<ScenarioKey, {
  label:   string;
  Icon:    React.ElementType;
  tagline: string;
  color:   string;
}> = {
  interview: {
    label:   "Technical Interview",
    Icon:    Briefcase,
    tagline: "Walk the interviewer through your understanding of this topic.",
    color:   "violet",
  },
  client: {
    label:   "Client Briefing",
    Icon:    Users,
    tagline: "A client needs to understand this topic to make a decision. Be their expert.",
    color:   "sky",
  },
  huddle: {
    label:   "Team Huddle",
    Icon:    MessageCircle,
    tagline: "A new teammate missed the context. Get them up to speed clearly.",
    color:   "amber",
  },
  teaching: {
    label:   "Teaching a Junior",
    Icon:    GraduationCap,
    tagline: "A junior developer is assigned to this area. Mentor them well.",
    color:   "green",
  },
};

const SCENARIO_KEYS = Object.keys(SCENARIOS) as ScenarioKey[];
const MAX_EXCHANGES = 3;

function randomScenario(): ScenarioKey {
  return SCENARIO_KEYS[Math.floor(Math.random() * SCENARIO_KEYS.length)];
}

// ── Color helpers ──────────────────────────────────────────────────────────

type ColorKey = "violet" | "sky" | "amber" | "green";

const COLOR_CLASSES: Record<ColorKey, { bg: string; border: string; text: string }> = {
  violet: { bg: "bg-violet-500/10", border: "border-violet-500/40", text: "text-violet-300" },
  sky:    { bg: "bg-sky-500/10",    border: "border-sky-500/40",    text: "text-sky-300"    },
  amber:  { bg: "bg-amber-500/10",  border: "border-amber-500/40",  text: "text-amber-300"  },
  green:  { bg: "bg-green-500/10",  border: "border-green-500/40",  text: "text-green-300"  },
};

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
  milestoneId:     string;
  milestoneTitle:  string;
  personaId:       string;
  returnUrl?:      string;
  /** The goal board to use when no returnUrl was supplied. */
  fallbackUrl:     string;
  alreadyMastered: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function MasteryClient({ milestoneId, milestoneTitle, personaId, returnUrl,
  fallbackUrl, alreadyMastered }: Props) {
  const router = useRouter();

  // returnUrl carries study-context when the learner came from
  // /study/[goalId]/track. fallbackUrl is that same board, resolved
  // server-side from the track's goal, for anyone arriving here directly.
  const boardUrl = returnUrl ?? fallbackUrl;

  const [phase,      setPhase]      = useState<Phase>("setup");
  const [scenario,   setScenario]   = useState<ScenarioKey>(randomScenario);
  const [pickMode,   setPickMode]   = useState(false);  // show scenario grid on retry
  const [messages,   setMessages]   = useState<ConversationMessage[]>([]);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [apiError,   setApiError]   = useState<string | null>(null);

  const speech      = useSpeechRecognition();
  const messagesRef = useRef<ConversationMessage[]>([]);

  // Keep ref in sync so async callbacks always see the latest messages
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // onEnded: always transitions to listening — safe because audio only plays
  // during "playing" phase (Hugh's turn), never during result or setup.
  const onAudioEnded = useCallback(() => setPhase("listening"), []);
  const audio        = useAudioPlayer({ onEnded: onAudioEnded });

  // ── Manage speech recognition lifecycle via phase ────────────────────────
  // Do NOT call speech.reset() here — it calls recognition.stop() internally,
  // and calling recognition.start() immediately after causes a race condition
  // where the engine hasn't fully stopped, so start() silently fails.
  // The transcript is already cleared by handleDone() between exchanges.
  useEffect(() => {
    if (phase === "listening") {
      speech.start();
    } else if (speech.isRecording) {
      speech.stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── API call helper ───────────────────────────────────────────────────────
  async function callSession(
    apiPhase: "open" | "respond" | "evaluate",
    msgs: ConversationMessage[],
    activeScenario: ScenarioKey,
  ) {
    const res = await fetch("/api/tracker/mastery/session", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ milestoneId, scenario: activeScenario, phase: apiPhase, messages: msgs }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error((d as { error?: string }).error ?? `Error ${res.status}`);
    }
    return res.json() as Promise<{ text?: string; score?: number; feedback?: string; passed?: boolean; record?: MasteryRecord }>;
  }

  // ── Start or restart a session ────────────────────────────────────────────
  async function startSession(chosen: ScenarioKey) {
    setScenario(chosen);
    setPickMode(false);
    setMessages([]);
    setEvaluation(null);
    setApiError(null);
    speech.reset();  // clear any transcript leftover from a previous session
    setPhase("generating");

    try {
      const data    = await callSession("open", [], chosen);
      const text    = data.text!;
      const initial = [{ role: "hugh" as const, text }];
      setMessages(initial);
      setPhase("playing");
      await audio.play(text, personaId);
      // onEnded → "listening"
    } catch (e) {
      setApiError((e as Error).message);
      setPhase("setup");
    }
  }

  // ── User finishes speaking ────────────────────────────────────────────────
  async function handleDone() {
    const captured = speech.transcript.trim();
    speech.reset();

    if (!captured) {
      // Nothing caught — restart listening
      setTimeout(() => setPhase("listening"), 250);
      return;
    }

    const learnerMsg: ConversationMessage = { role: "learner", text: captured };
    const updated                         = [...messagesRef.current, learnerMsg];
    setMessages(updated);

    const learnerCount = updated.filter(m => m.role === "learner").length;

    if (learnerCount >= MAX_EXCHANGES) {
      setPhase("evaluating");
      try {
        const data = await callSession("evaluate", updated, scenario);
        setEvaluation({ score: data.score!, feedback: data.feedback!, passed: data.passed!, record: data.record! });
      } catch (e) {
        setApiError((e as Error).message);
      }
      setPhase("result");
      return;
    }

    setPhase("thinking");
    try {
      const data    = await callSession("respond", updated, scenario);
      const text    = data.text!;
      const hughMsg: ConversationMessage = { role: "hugh", text };
      const next    = [...updated, hughMsg];
      setMessages(next);
      setPhase("playing");
      await audio.play(text, personaId);
      // onEnded → "listening"
    } catch (e) {
      setApiError((e as Error).message);
      setPhase("listening"); // let user retry their turn
    }
  }

  // ── Clean exit: stop audio/speech before navigating ──────────────────────
  // Runs as the onNavigate of an <ExitLink> (see components/ui/ExitLink), so the
  // teardown happens while the prefetched board is already loading.
  function stopPlayback() {
    audio.stop();
    speech.reset();
  }

  // The result is recorded by the server the moment the session is scored
  // (lib/mastery/outcome.ts); this page no longer writes it. So the buttons on
  // the result screen only navigate, and they are shown only when the server
  // reports the result saved. The board celebrates a card arriving with
  // ?mastered=, and that must never fire for a result that was not recorded.
  // The summary document is still generated lazily by the milestone drawer.
  function navigateBackMastered() {
    const sep = boardUrl.includes("?") ? "&" : "?";
    router.push(`${boardUrl}${sep}mastered=${milestoneId}`);
  }

  // ── Derived values ────────────────────────────────────────────────────────
  const learnerCount    = messages.filter(m => m.role === "learner").length;
  const currentExchange = Math.min(learnerCount + 1, MAX_EXCHANGES);
  const cfg             = SCENARIOS[scenario];
  const colors          = COLOR_CLASSES[cfg.color as ColorKey];
  const isBusy          = ["generating", "thinking", "evaluating"].includes(phase);
  const saveFailed      = evaluation?.record === "failed";
  // On an already-mastered card every practice run is "positive" — mastery is
  // locked, so we never show a fail/almost framing.
  const positive        = alreadyMastered || !!evaluation?.passed;

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
          onNavigate={stopPlayback}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition-colors"
        />
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Mastery Session</p>
          <p className="mt-0.5 max-w-[280px] truncate text-sm font-semibold text-slate-200">{milestoneTitle}</p>
        </div>
        {/* Exchange progress dots */}
        <div className="flex items-center gap-1.5">
          {Array.from({ length: MAX_EXCHANGES }).map((_, i) => (
            <div
              key={i}
              className={`h-2 w-2 rounded-full transition-colors duration-300 ${
                i < learnerCount
                  ? "bg-green-400"
                  : i === learnerCount && !["result", "setup", "evaluating"].includes(phase)
                  ? "bg-amber-400 animate-pulse"
                  : "bg-slate-700"
              }`}
            />
          ))}
        </div>
      </header>

      {/* ── SETUP / SCENARIO ─────────────────────────────────────────────── */}
      {phase === "setup" && (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-10">
          {pickMode ? (
            <div className="w-full max-w-lg space-y-4">
              <div className="text-center mb-6">
                <p className="text-lg font-semibold text-slate-200">Choose a scenario</p>
                <p className="mt-1 text-sm text-slate-500">Pick the context that feels most challenging.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {SCENARIO_KEYS.map(key => {
                  const s    = SCENARIOS[key];
                  const sc   = COLOR_CLASSES[s.color as ColorKey];
                  const Icon = s.Icon;
                  return (
                    <button
                      key={key}
                      onClick={() => startSession(key)}
                      className={`flex flex-col items-start gap-2 rounded-2xl border p-4 text-left transition-all hover:brightness-110 ${sc.bg} ${sc.border}`}
                    >
                      <Icon size={18} className={sc.text} />
                      <p className={`text-sm font-semibold ${sc.text}`}>{s.label}</p>
                      <p className="text-xs text-slate-500 leading-relaxed">{s.tagline}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="w-full max-w-md space-y-6 text-center">
              <div className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-semibold ${colors.bg} ${colors.border} ${colors.text}`}>
                <cfg.Icon size={14} />
                {cfg.label}
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-100">
                  {alreadyMastered ? "Practice Your Mastery" : "Profess Your Mastery"}
                </h1>
                <p className="mt-3 text-sm text-slate-400 leading-relaxed max-w-sm mx-auto">
                  {cfg.tagline} Hugh leads a 3-exchange voice conversation.{" "}
                  {alreadyMastered
                    ? "This is a practice run — your mastery is already locked in, so explore freely."
                    : <>Score <span className="text-slate-200 font-semibold">7 or higher</span> to confirm mastery.</>}
                </p>
              </div>
              <div className={`rounded-2xl border px-5 py-4 text-sm text-slate-400 leading-relaxed text-left ${colors.bg} ${colors.border}`}>
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2">How it works</p>
                Hugh opens the conversation in character. You respond by voice 3 times — keep it clear, accurate, and confident. Hugh evaluates and scores your explanation after the final exchange.
              </div>
              {apiError && (
                <p className="text-sm text-red-400">{apiError}</p>
              )}
              <button
                onClick={() => startSession(scenario)}
                className={`w-full rounded-2xl border py-3.5 text-sm font-bold transition-all hover:brightness-110 ${colors.bg} ${colors.border} ${colors.text}`}
              >
                Begin Session
              </button>
              <button
                onClick={() => setPickMode(true)}
                className="text-xs text-slate-600 hover:text-slate-400 transition-colors"
              >
                Change scenario
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── ACTIVE CONVERSATION ───────────────────────────────────────────── */}
      {!["setup", "result"].includes(phase) && (
        <div className="relative z-10 flex flex-1 flex-col min-h-0">
          {/* Exchange counter */}
          {!["evaluating"].includes(phase) && (
            <div className="shrink-0 flex justify-center py-3">
              <span className="rounded-full bg-slate-800/80 px-3 py-1 text-xs font-semibold text-slate-400">
                Exchange {currentExchange} of {MAX_EXCHANGES}
              </span>
            </div>
          )}

          {/* Message thread */}
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
            <div className="max-w-2xl mx-auto space-y-4">

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

              {/* Live transcript while the user is recording */}
              {phase === "listening" && (
                <div className="flex gap-3 max-w-[85%] ml-auto flex-row-reverse">
                  <div className="shrink-0 mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-sky-900/60 text-xs font-bold text-sky-300">
                    Y
                  </div>
                  <div className="rounded-2xl rounded-tr-sm border border-sky-700/50 bg-sky-900/40 px-4 py-3 min-w-[120px]">
                    {speech.transcript ? (
                      <p className="text-sm text-slate-200 leading-relaxed">{speech.transcript}</p>
                    ) : (
                      <p className="text-sm text-slate-500 italic">Listening…</p>
                    )}
                  </div>
                </div>
              )}

              {/* Spinner states */}
              {isBusy && (
                <div className="flex items-center gap-2 text-xs text-slate-500 px-1 py-2">
                  <Loader2 size={12} className="animate-spin" />
                  {phase === "generating" && "Hugh is setting the scene…"}
                  {phase === "thinking"   && "Hugh is responding…"}
                  {phase === "evaluating" && "Hugh is evaluating your responses…"}
                </div>
              )}

            </div>
          </div>

          {/* Bottom mic area */}
          <div className="shrink-0 border-t border-slate-800/60 px-6 py-5">
            <div className="max-w-2xl mx-auto flex flex-col items-center gap-4">

              <div className="flex items-center justify-center gap-5">
                {phase === "listening" && (
                  <>
                    <div className="relative flex items-center justify-center">
                      <div className="absolute h-12 w-12 rounded-full bg-red-500/20 animate-ping" />
                      <div className="relative flex h-10 w-10 items-center justify-center rounded-full border border-red-500/50 bg-red-500/20">
                        <Mic size={18} className="text-red-400" />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5 items-start">
                      <button
                        onClick={handleDone}
                        className="flex items-center gap-2 rounded-xl bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 transition-colors"
                      >
                        <MicOff size={15} />
                        Done talking
                      </button>
                      {!speech.isSupported && (
                        <p className="text-xs text-red-400">Chrome or Edge required for voice input</p>
                      )}
                    </div>
                  </>
                )}

                {phase === "playing" && (
                  <div className="flex items-center gap-3 text-sm text-slate-400">
                    <div className="flex gap-1 items-end h-5">
                      {[0, 1, 2, 3].map(i => (
                        <div
                          key={i}
                          className="w-1 rounded-full bg-amber-400/70"
                          style={{
                            height: `${40 + i * 15}%`,
                            animation: `waveBar 0.7s ease-in-out infinite ${i * 0.12}s alternate`,
                          }}
                        />
                      ))}
                    </div>
                    Hugh is speaking…
                  </div>
                )}
              </div>

              {/* End session — always visible during active conversation */}
              <ExitLink
                href={boardUrl}
                label="End session & take a break"
                onNavigate={stopPlayback}
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
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-10">
          <div className="w-full max-w-md space-y-5">

            {/* Score card */}
            <div className={`rounded-3xl border p-6 text-center ${
              positive
                ? "border-green-500/30 bg-green-500/5"
                : "border-amber-500/30 bg-amber-500/5"
            }`}>
              <div className={`text-5xl font-black mb-1 ${positive ? "text-green-300" : "text-amber-300"}`}>
                {evaluation?.score ?? "—"}
                <span className="text-2xl font-normal text-slate-500">/10</span>
              </div>
              <p className={`text-sm font-semibold ${positive ? "text-green-400" : "text-amber-400"}`}>
                {saveFailed
                  ? "Scored, but not saved"
                  : alreadyMastered
                  ? "Still mastered — practice logged"
                  : evaluation?.passed
                  ? "Mastery confirmed"
                  : "Almost — one more try will get you there"}
              </p>
            </div>

            {/* Feedback */}
            {evaluation?.feedback && (
              <div className="rounded-2xl border border-slate-700/60 bg-slate-800/40 px-5 py-4">
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2">Hugh&apos;s Feedback</p>
                <p className="text-sm text-slate-300 leading-relaxed">{evaluation.feedback}</p>
              </div>
            )}

            {/* Error fallback */}
            {apiError && !evaluation && (
              <p className="text-sm text-red-400 text-center">{apiError}</p>
            )}

            {/* Scenario tag */}
            <div className="flex justify-center">
              <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${colors.bg} ${colors.border} ${colors.text}`}>
                <cfg.Icon size={12} />
                {cfg.label}
              </div>
            </div>

            {/* CTA. A scored session the server could not record gets its own
                copy and its own way out (rule 5): the score above is real, only
                the saving failed, and running the session again scores and
                records afresh. The board link leaves without a record. Every
                other button only navigates, because the server has already
                recorded the result. */}
            {saveFailed ? (
              <div className="space-y-2.5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3.5">
                <div className="flex items-start gap-2.5">
                  <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                  <p className="text-sm text-red-300">
                    Hugh scored this session but couldn&apos;t save the result. Your score above is real; run the session again to record it.
                  </p>
                </div>
                <button
                  onClick={() => startSession(scenario)}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-red-500/20 py-2.5 text-sm font-semibold text-red-200 hover:bg-red-500/30 transition-colors"
                >
                  <RotateCcw size={14} />
                  Run it again
                </button>
                <ExitLink
                  href={boardUrl}
                  label="Back to board without saving"
                  onNavigate={stopPlayback}
                  showIcon={false}
                  className="block w-full rounded-xl border border-red-500/30 py-2 text-center text-xs text-red-300/80 hover:text-red-200 hover:border-red-500/50 transition-colors"
                />
              </div>
            ) : alreadyMastered ? (
              <div className="space-y-2">
                <button
                  onClick={navigateBackMastered}
                  className="w-full flex items-center justify-center gap-2 rounded-2xl bg-green-600 py-3.5 text-sm font-bold text-white hover:bg-green-500 transition-colors"
                >
                  <Trophy size={16} />
                  Finish
                </button>
                <button
                  onClick={() => { setPickMode(true); setPhase("setup"); setMessages([]); setEvaluation(null); }}
                  className="w-full flex items-center justify-center gap-2 rounded-2xl border border-slate-700 py-3 text-sm text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
                >
                  <RotateCcw size={14} />
                  Practice again
                </button>
              </div>
            ) : evaluation?.passed ? (
              <button
                onClick={navigateBackMastered}
                className="w-full flex items-center justify-center gap-2 rounded-2xl bg-green-600 py-3.5 text-sm font-bold text-white hover:bg-green-500 transition-colors"
              >
                <Trophy size={16} />
                Continue
              </button>
            ) : (
              <div className="space-y-2">
                <button
                  onClick={() => { setPickMode(true); setPhase("setup"); setMessages([]); setEvaluation(null); }}
                  className="w-full flex items-center justify-center gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 py-3 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 transition-colors"
                >
                  <RotateCcw size={14} />
                  Try a different scenario
                </button>
                <button
                  onClick={() => startSession(scenario)}
                  className="w-full rounded-2xl border border-slate-700 py-3 text-sm text-slate-500 hover:text-slate-300 hover:border-slate-600 transition-colors"
                >
                  Same scenario, fresh start
                </button>
              </div>
            )}

          </div>
        </div>
      )}

    </div>
  );
}
