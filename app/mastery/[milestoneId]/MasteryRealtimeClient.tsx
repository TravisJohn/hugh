"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Mic, Loader2, RotateCcw, AlertTriangle, Undo2, Sparkles,
} from "lucide-react";
import ExitLink from "@/components/ui/ExitLink";
import { useMasteryRealtime } from "@/hooks/useMasteryRealtime";
import type { MasteryRealtimeStatus } from "@/types";
import SummaryPanel from "./SummaryPanel";

type Phase = "intro" | "live" | "recapping" | "recap";

interface Props {
  milestoneId:     string;
  milestoneTitle:  string;
  returnUrl?:      string;
  /** The goal board to use when no returnUrl was supplied. */
  fallbackUrl:     string;
  alreadyMastered: boolean;
  summaryDoc:      string | null;
  summaryDocAt:    string | null;
}

const STATUS_LABEL: Record<MasteryRealtimeStatus, string> = {
  idle:           "",
  connecting:     "Connecting…",
  coach_speaking: "Coach is speaking…",
  listening:      "Listening…",
  thinking:       "Thinking…",
  concluding:     "Wrapping up…",
  error:          "",
  disconnected:   "",
};

export default function MasteryRealtimeClient({
  milestoneId, milestoneTitle, returnUrl,
  fallbackUrl, alreadyMastered,
  summaryDoc, summaryDocAt,
}: Props) {
  const router = useRouter();

  const boardUrl = returnUrl ?? fallbackUrl;

  const [phase,       setPhase]       = useState<Phase>("intro");
  const [recap,       setRecap]       = useState<string | null>(null);
  const [recapError,  setRecapError]  = useState<string | null>(null);
  const [sendingReview, setSendingReview] = useState(false);

  // Latest saved summary — lifted from SummaryPanel so every phase renders the
  // current doc (and the live coach reads the freshest one server-side at connect).
  const [summary, setSummary] = useState<{ doc: string | null; at: string | null }>({
    doc: summaryDoc, at: summaryDocAt,
  });

  const { status, error, transcript, endReason, connect, endByUser, disconnect } = useMasteryRealtime();

  const recapRanRef = useRef(false);

  // ── Non-judgmental recap (runs once, when the session ends) ─────────────────
  const runRecap = useCallback(async () => {
    if (recapRanRef.current) return;
    recapRanRef.current = true;
    setPhase("recapping");
    try {
      const res = await fetch("/api/tracker/mastery/recap", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ milestoneId, transcript }),
      });
      const b = (await res.json().catch(() => ({}))) as { recap?: string; error?: string };
      if (!res.ok || !b.recap) setRecapError(b.error ?? "Couldn't write a recap this time.");
      else setRecap(b.recap);
    } catch {
      setRecapError("Couldn't reach the recap service.");
    }
    setPhase("recap");
  }, [milestoneId, transcript]);

  // When the hook signals the session ended, write the recap. Guarded to fire once.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (endReason && phase === "live") void runRecap();
  }, [endReason, phase, runRecap]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  async function begin() {
    setRecap(null);
    setRecapError(null);
    recapRanRef.current = false;
    setPhase("live");
    await connect(milestoneId);
    // On failure the hook sets status='error'; the live pane renders the banner.
  }

  // Leaving is an <ExitLink> (see components/ui/ExitLink) — `disconnect` runs as
  // its onNavigate. This one still needs router.push: the board reads the column
  // change, so the PATCH has to land before we navigate.
  async function sendToReview() {
    setSendingReview(true);
    try {
      await fetch(`/api/tracker/milestones/${milestoneId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ column: "review", reviewValidated: false }),
      });
    } catch { /* best-effort — still navigate back */ }
    router.push(boardUrl);
  }

  const isConnErr = status === "error" && !!error;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen bg-[#0F172A] flex flex-col overflow-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="animate-breathe absolute top-0 right-1/4 h-[500px] w-[500px] -translate-y-1/2 rounded-full bg-violet-500/[0.07] blur-3xl" />
        <div className="animate-breathe-delayed absolute bottom-0 left-1/4 h-[600px] w-[600px] translate-y-1/2 rounded-full bg-sky-500/[0.06] blur-3xl" />
      </div>

      {/* Header */}
      <header className="relative z-10 shrink-0 flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <ExitLink
          href={boardUrl}
          label="Back"
          onNavigate={disconnect}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition-colors"
        />
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Reflect · Live</p>
          <p className="mt-0.5 max-w-[280px] truncate text-sm font-semibold text-slate-200">{milestoneTitle}</p>
        </div>
        <div className="w-12" />
      </header>

      {/* Two-pane body: left = phase content, right = guiding summary */}
      <main className="relative z-10 flex flex-1 min-h-0 gap-4 px-4 py-4 md:px-6">
        <section className="flex flex-1 min-h-0 flex-col">
          {/* ── INTRO ─────────────────────────────────────────────────────── */}
          {phase === "intro" && (
            <div className="flex flex-1 flex-col items-center justify-center px-2">
              <div className="w-full max-w-md space-y-6 text-center">
                <h1 className="text-2xl font-bold text-slate-100">
                  {alreadyMastered ? "Talk it through again" : "Talk it through"}
                </h1>
                <p className="text-sm text-slate-400 leading-relaxed">
                  This is a relaxed, spoken reflection on <span className="text-slate-200 font-semibold">{milestoneTitle}</span> —
                  no test, no score. Your summary is on the right to guide you. When you start,
                  Hugh will simply ask what stuck with you, then follow your train of thought.
                </p>
                <button
                  onClick={() => void begin()}
                  className="w-full flex items-center justify-center gap-2 rounded-2xl border border-violet-500/40 bg-violet-500/10 py-3.5 text-sm font-bold text-violet-200 transition-all hover:brightness-110"
                >
                  <Mic size={16} />
                  Start the conversation
                </button>
                <p className="text-xs text-slate-600">Your browser will ask for microphone access.</p>
              </div>
            </div>
          )}

          {/* ── LIVE ──────────────────────────────────────────────────────── */}
          {phase === "live" && (
            isConnErr ? (
              <div className="flex flex-1 flex-col items-center justify-center px-2">
                <div className="w-full max-w-md space-y-4 text-center">
                  <AlertTriangle size={28} className="mx-auto text-amber-400" />
                  <p className="text-sm text-slate-300">{error?.message}</p>
                  <div className="space-y-2">
                    <button
                      onClick={() => void begin()}
                      className="w-full rounded-2xl border border-slate-600 py-3 text-sm font-semibold text-slate-200 hover:border-slate-400 transition-colors"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              // Calm, listen-and-talk view. We deliberately do NOT show the live
              // transcript — it was distracting (and mis-guessed languages). The
              // conversation is still captured silently for the end recap.
              <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-10 px-4">
                <div className="flex flex-col items-center gap-6">
                  <LiveOrb status={status} />
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-300">
                    {(status === "connecting" || status === "thinking" || status === "concluding") && (
                      <Loader2 size={13} className="animate-spin" />
                    )}
                    {STATUS_LABEL[status] || "Listening…"}
                  </div>
                  <p className="max-w-xs text-center text-xs leading-relaxed text-slate-600">
                    Talk naturally — no need to read along. Take your time; your summary is on the right to guide you.
                  </p>
                </div>

                <button
                  onClick={endByUser}
                  className="rounded-xl bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 transition-colors"
                >
                  End &amp; see recap
                </button>
              </div>
            )
          )}

          {/* ── RECAPPING ─────────────────────────────────────────────────── */}
          {phase === "recapping" && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              <Loader2 size={28} className="animate-spin text-violet-400" />
              <p className="text-sm text-slate-400">Writing your recap…</p>
            </div>
          )}

          {/* ── RECAP ─────────────────────────────────────────────────────── */}
          {phase === "recap" && (
            <div className="flex flex-1 min-h-0 flex-col overflow-y-auto px-2">
              <div className="m-auto w-full max-w-md space-y-5 py-6">
                <div className="rounded-3xl border border-violet-500/25 bg-violet-500/[0.06] p-6">
                  <div className="mb-2 flex items-center gap-2">
                    <Sparkles size={16} className="text-violet-300" />
                    <p className="text-xs font-semibold uppercase tracking-widest text-violet-300/80">Reflection recap</p>
                  </div>
                  <p className="text-sm leading-relaxed text-slate-200">
                    {recap ?? recapError ?? "That's a wrap on this reflection."}
                  </p>
                </div>

                <p className="text-center text-xs text-slate-500">
                  Spotted a gap? Update your summary on the right — then revisit the card whenever you like.
                </p>

                <div className="space-y-2">
                  <ExitLink
                    href={boardUrl}
                    label="Back to board"
                    onNavigate={disconnect}
                    className="w-full flex items-center justify-center gap-2 rounded-2xl bg-slate-700 py-3.5 text-sm font-bold text-white hover:bg-slate-600 transition-colors"
                  />
                  <button
                    onClick={() => void sendToReview()}
                    disabled={sendingReview}
                    className="w-full flex items-center justify-center gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 py-3 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 transition-colors disabled:opacity-60"
                  >
                    {sendingReview ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
                    Send this card back to review
                  </button>
                  <button
                    onClick={() => setPhase("intro")}
                    className="w-full flex items-center justify-center gap-2 rounded-2xl border border-slate-700 py-3 text-sm text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
                  >
                    <RotateCcw size={14} /> Reflect again
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Right pane — the guiding summary (read-only while live) */}
        <aside className="hidden md:block w-[380px] shrink-0 min-h-0">
          <SummaryPanel
            milestoneId={milestoneId}
            milestoneTitle={milestoneTitle}
            initialDoc={summary.doc}
            initialDocAt={summary.at}
            editable={phase !== "live"}
            onDocChange={(doc, at) => setSummary({ doc, at })}
          />
        </aside>
      </main>
    </div>
  );
}

// A quiet presence for the live session: a breathing ring that pulses while the
// learner speaks and glows while Hugh speaks — no scrolling text to read.
function LiveOrb({ status }: { status: MasteryRealtimeStatus }) {
  const speaking  = status === "coach_speaking";
  const listening = status === "listening";
  const active    = speaking || listening;

  return (
    <div className="relative flex h-32 w-32 items-center justify-center">
      <span
        className={`absolute inset-0 rounded-full ${
          speaking ? "bg-violet-500/20" : listening ? "bg-red-500/15" : "bg-slate-600/10"
        } ${active ? "animate-ping" : ""}`}
      />
      <div
        className={`relative flex h-24 w-24 items-center justify-center rounded-full border transition-colors ${
          speaking ? "border-violet-400/50 bg-violet-500/10" : "border-slate-600 bg-slate-800/60"
        }`}
      >
        <Mic size={30} className={speaking ? "text-violet-300" : listening ? "text-red-300" : "text-slate-300"} />
      </div>
    </div>
  );
}
