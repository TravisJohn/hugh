"use client";

import { useState } from "react";
import { MessageSquarePlus, Loader2, Check } from "lucide-react";
import { checkRequest, MAX_REQUEST_CHARS, REQUEST_REJECTION_MESSAGE } from "@/lib/learn/topicRequest";

// The request box under the course catalog (PRD-narrow-learn.md, row 6). It
// saves one line for Travis to read in /admin and builds nothing, so saying so
// plainly is part of the copy: a learner must not expect a course to appear.

type BoxState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; text: string }
  | { kind: "error"; message: string };

export default function TopicRequestBox() {
  const [text, setText]   = useState("");
  const [state, setState] = useState<BoxState>({ kind: "idle" });

  async function send() {
    // The same rule the route applies, so an obvious mistake never makes a round trip.
    const checked = checkRequest(text);
    if (!checked.ok) {
      setState({ kind: "error", message: REQUEST_REJECTION_MESSAGE[checked.rejection] });
      return;
    }
    setState({ kind: "sending" });
    try {
      const res  = await fetch("/api/dashboard/topic-requests", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ topic: checked.text }),
      });
      const data = await res.json().catch(() => ({})) as { saved?: boolean; error?: string };
      if (!res.ok || !data.saved) {
        setState({ kind: "error", message: data.error ?? "Hugh couldn't save your request. Nothing was saved — try again." });
        return;
      }
      setText("");
      setState({ kind: "sent", text: checked.text });
    } catch {
      setState({ kind: "error", message: "Hugh could not be reached. Nothing was saved — try again." });
    }
  }

  const sending = state.kind === "sending";

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-3">
      <label htmlFor="topic-request" className="flex items-center gap-2 text-xs font-medium text-slate-300">
        <MessageSquarePlus size={14} className="text-slate-400" />
        Missing a subject? Tell Hugh which one to add next.
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id="topic-request"
          value={text}
          maxLength={MAX_REQUEST_CHARS}
          disabled={sending}
          onChange={e => {
            setText(e.target.value);
            if (state.kind !== "idle" && state.kind !== "sending") setState({ kind: "idle" });
          }}
          onKeyDown={e => { if (e.key === "Enter") void send(); }}
          placeholder="e.g. Causal inference"
          className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
        />
        <button
          onClick={() => void send()}
          disabled={sending}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-400 disabled:opacity-60"
        >
          {sending && <Loader2 size={12} className="animate-spin" />}
          Ask for it
        </button>
      </div>
      {state.kind === "sent" && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-300">
          <Check size={12} />
          Saved &ldquo;{state.text}&rdquo;. It doesn&apos;t start a course; it tells Hugh what to build next.
        </p>
      )}
      {state.kind === "error" && <p className="mt-2 text-xs text-red-300">{state.message}</p>}
    </section>
  );
}
