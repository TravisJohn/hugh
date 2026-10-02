"use client";

import { useState, useEffect, useRef } from "react";
import {
  Loader2, ArrowRight, Brain, ChevronLeft, AlertTriangle, Upload, FileText, RotateCcw,
} from "lucide-react";
import { useTrackStatusWatch } from "@/hooks/useTrackStatusWatch";
import { type LearningGoal, type TrackStatus } from "@/types";
import {
  type TopicDomainVerdict,
  normalizeVerdict,
} from "@/lib/learn/topic-domain";
import TopicGateNotice from "./TopicGateNotice";

interface Props {
  endDate:       string;
  // Pre-selected in the idle panel before this flow ever mounts — when set,
  // the "picking" phase is skipped and analysis starts immediately so the
  // user isn't asked to pick the same file twice. See DashboardPanel.
  initialFile?:  File | null;
  onGoalCreated: (goal: LearningGoal) => void;
  onCancel:      () => void;
}

const FALLBACK_TIPS = [
  "The best learners tie new concepts to real problems they're already solving.",
  "Teaching what you learn — even to yourself — can accelerate retention by up to 50%.",
  "Short, focused sessions beat marathon study. 25 minutes of deep work outperforms 2 hours of distracted reading.",
];

export const ACCEPT =
  ".pdf,.docx,.html,.htm,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/html";

type Phase = "picking" | "extracting" | "reviewing" | "waiting" | "failed";

interface ExtractResponse {
  verdict?:        TopicDomainVerdict["verdict"];
  goal?:           LearningGoal;
  candidateTopic?: string;
  tips?:           string[];
  truncated?:      boolean;
  error?:          string;
  // A BLOCKED response is the verdict itself, at the top level — which is why
  // the whole body is handed to normalizeVerdict rather than one field of it.
  // `gate` is the other case: a successful extract whose topic still needs the
  // learner to pick an angle in the review step.
  gate?:           TopicDomainVerdict | null;
}

// Sibling to RefinementFlow: same phase-driven shape and the same waiting/
// failed screens, but the learner uploads a document instead of answering
// questions. See PRD-course-from-document.md for the two-request design
// (extract → review → approve) and the prompt-injection defenses this
// review step is part of (§6 layer 5 — a human reviews the extracted topic
// before generateTrack ever runs).
export default function DocumentUploadFlow({ endDate, initialFile, onGoalCreated, onCancel }: Props) {
  const [phase, setPhase]     = useState<Phase>(initialFile ? "extracting" : "picking");
  const [file, setFile]       = useState<File | null>(initialFile ?? null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<TopicDomainVerdict | null>(null);

  const [goal, setGoal]                 = useState<LearningGoal | null>(null);
  const [candidateTopic, setCandidateTopic] = useState("");
  const [tips, setTips]                 = useState<string[]>(FALLBACK_TIPS);
  const [truncated, setTruncated]       = useState(false);
  const [approving, setApproving]       = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [tipIdx, setTipIdx]             = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoAnalyzeStarted = useRef(false);

  // File was already picked in the idle panel — start analysis as soon as we
  // mount instead of making the user pick it again and press a second button.
  useEffect(() => {
    if (initialFile && !autoAnalyzeStarted.current) {
      autoAnalyzeStarted.current = true;
      void handleAnalyze(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tip rotator during waiting — identical cadence to RefinementFlow's.
  useEffect(() => {
    if (phase !== "waiting") return;
    const id = setInterval(() => {
      setTipIdx(i => (i + 1) % tips.length);
    }, 5000);
    return () => clearInterval(id);
  }, [phase, tips.length]);

  useTrackStatusWatch({
    goalId:   goal?.id ?? null,
    active:   phase === "waiting",
    onReady:  () => goal && onGoalCreated({ ...goal, topic: candidateTopic, track_status: "ready" }),
    onFailed: () => setPhase("failed"),
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setPickError(null);
    setBlocked(null);
  }

  async function handleAnalyze(fileArg?: File) {
    const f = fileArg ?? file;
    if (!f) return;
    setPhase("extracting");
    setPickError(null);
    setBlocked(null);

    try {
      const form = new FormData();
      form.set("file", f);
      form.set("end_date", endDate);

      const res  = await fetch("/api/dashboard/goals/document/extract", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as ExtractResponse;

      if (!res.ok || data.error) {
        setPickError(data.error ?? "Something went wrong reading that file.");
        setPhase("picking");
        return;
      }
      // Extract carries "needs_angle" through to the review step, where the
      // learner has a field to answer it. A bare verdict here is a refusal.
      if (!data.goal || !data.candidateTopic) {
        if (data.verdict) setBlocked(normalizeVerdict(data));
        else setPickError("Something went wrong reading that file.");
        setPhase("picking");
        return;
      }

      setGoal(data.goal);
      setCandidateTopic(data.candidateTopic);
      if (data.tips && data.tips.length > 0) setTips(data.tips);
      setTruncated(!!data.truncated);
      setBlocked(data.gate ?? null);
      setPhase("reviewing");
    } catch {
      setPickError("Something went wrong reading that file.");
      setPhase("picking");
    }
  }

  async function handleApprove() {
    if (!goal || approving) return;
    setApproving(true);
    setApproveError(null);
    setBlocked(null);

    try {
      const res  = await fetch("/api/dashboard/goals/document/approve", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ goalId: goal.id, topic: candidateTopic.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as ExtractResponse;

      if (!res.ok || !data.goal) {
        if (data.error) setApproveError(data.error);
        else if (data.verdict) setBlocked(normalizeVerdict(data));
        else setApproveError("Something went wrong — please try again.");
        setApproving(false);
        return;
      }

      setGoal(data.goal);
      setPhase("waiting");
    } catch {
      setApproveError("Something went wrong — please try again.");
      setApproving(false);
    }
  }

  async function handleStartOver() {
    if (goal) {
      await fetch(`/api/dashboard/goals/${goal.id}`, { method: "DELETE" }).catch(() => {});
    }
    setGoal(null);
    setFile(null);
    setCandidateTopic("");
    setTips(FALLBACK_TIPS);
    setTruncated(false);
    setBlocked(null);
    setPickError(null);
    setApproveError(null);
    setApproving(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setPhase("picking");
  }

  function handleTopicEdit(value: string) {
    setCandidateTopic(value);
    if (blocked) setBlocked(null);
  }

  // ── Failed phase (identical treatment to RefinementFlow's) ────────────────
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
          onClick={() => goal && onGoalCreated({ ...goal, track_status: "failed" as TrackStatus })}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-900 hover:bg-amber-400 transition-colors"
        >
          Go to my library
          <ArrowRight size={14} />
        </button>
      </div>
    );
  }

  // ── Waiting phase (identical treatment to RefinementFlow's) ───────────────
  if (phase === "waiting") {
    return (
      <div className="flex flex-col gap-5">
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

          <div className="h-1 w-32 overflow-hidden rounded-full bg-slate-700">
            <div className="h-full w-1/3 animate-progress-slide rounded-full bg-amber-500" />
          </div>
        </div>

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

  // ── Reviewing phase — the confirmation gate (§6 layer 5) ──────────────────
  if (phase === "reviewing") {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <button
            onClick={handleStartOver}
            className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-400 transition-colors"
          >
            <RotateCcw size={12} />
            Upload a different file
          </button>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-slate-600">
            Course topic (from your document — edit if needed)
          </p>
          <input
            type="text"
            value={candidateTopic}
            onChange={e => handleTopicEdit(e.target.value)}
            maxLength={200}
            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-100 focus:outline-none focus:border-amber-500 transition-colors"
          />
        </div>

        {tips.length > 0 && (
          <div className="rounded-xl border border-slate-700/60 bg-slate-800/50 p-4">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-slate-600">
              What Hugh noticed
            </p>
            <ul className="space-y-1">
              {tips.map((t, i) => (
                <li key={i} className="text-sm text-slate-300 leading-relaxed">{t}</li>
              ))}
            </ul>
          </div>
        )}

        {truncated && (
          <p className="text-xs text-amber-400/80">
            Your document was long — Hugh used the first portion of it to scope this course.
          </p>
        )}

        {blocked && <TopicGateNotice verdict={blocked} onPickSuggestion={handleTopicEdit} />}

        {approveError && <p className="text-xs text-red-400">{approveError}</p>}

        <button
          onClick={handleApprove}
          disabled={!candidateTopic.trim() || approving}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-900 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {approving ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              Starting…
            </>
          ) : (
            <>
              Build my track
              <ArrowRight size={14} />
            </>
          )}
        </button>
      </div>
    );
  }

  // ── Picking / extracting phase ────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <button
          onClick={onCancel}
          className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-400 transition-colors"
        >
          <ChevronLeft size={12} />
          Back
        </button>
      </div>

      <label
        htmlFor="document-upload-input"
        className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-slate-700 bg-slate-800/50 px-4 py-8 text-center hover:border-slate-500 transition-colors"
      >
        {file ? (
          <>
            <FileText size={22} className="text-amber-400" />
            <span className="text-sm text-slate-200">{file.name}</span>
            <span className="text-xs text-slate-600">Click to choose a different file</span>
          </>
        ) : (
          <>
            <Upload size={22} className="text-slate-500" />
            <span className="text-sm text-slate-300">Upload a PDF, DOCX, or HTML file</span>
            <span className="text-xs text-slate-600">A job description, syllabus, or textbook chapter works well</span>
          </>
        )}
        <input
          id="document-upload-input"
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          onChange={handleFileChange}
          className="hidden"
        />
      </label>

      {pickError && <p className="text-xs text-red-400">{pickError}</p>}

      {blocked && <TopicGateNotice verdict={blocked} />}

      <button
        onClick={() => handleAnalyze()}
        disabled={!file || phase === "extracting"}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-900 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {phase === "extracting" ? (
          <>
            <Loader2 size={15} className="animate-spin" />
            Reading your document…
          </>
        ) : (
          <>
            Analyze document
            <ArrowRight size={14} />
          </>
        )}
      </button>
    </div>
  );
}
