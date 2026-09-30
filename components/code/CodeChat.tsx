"use client";

import { recentTextMessages } from "@/lib/claude/textInput";

import { useEffect, useRef, useState } from "react";
import type { DrillLang } from "@/types/code";
import Image from "next/image";
import { X, Send, Loader2, Code2, Type, Pin, Check } from "lucide-react";
import CmEditor from "./CmEditor";

/** The drill card the chat is grounded on — used for context + as the pin target. */
export interface ChatCard { id: string; task: string; solution: string }

interface Msg { role: "user" | "assistant"; content: string }

interface Props {
  /** Controlled open state. Omit both to let the chat manage its own (landing use). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Card the chat is scoped to (a card's Ask icon, or the active cell). */
  focusCard?: ChatCard | null;
  /** One-line dataset description, e.g. "a list of dicts named `rows` (columns: name, team, sales, region)". */
  datasetLabel?: string;
  /**
   * One sentence telling Hugh which language and data shape to answer in.
   * Supplied by the drill, the only place that knows whether a Python pack is
   * pandas or plain dicts. Omitted on the landing page, where there is no drill
   * and so nothing true to say about the data.
   */
  langGuidance?: string;
  /** Language for the code-mode composer's fence. Defaults to Python. */
  lang?: DrillLang;
  /** Pin a message's text to a card for later reference. Omit to hide pinning. */
  onPin?: (cardId: string, text: string) => void;
}

const WELCOME: Msg = {
  role: "assistant",
  content: "Hey, I'm Hugh 👋 Ask about any step — or hit the code button to write a snippet inside your question.",
};

function codeFence(code: string, lang: DrillLang): string {
  return "```" + lang + "\n" + code.trim() + "\n```";
}

/**
 * Floating coding helper for the Code drill. Controlled by the parent so a card's
 * "Ask Hugh" icon can open it scoped to that step; that card (task + reference +
 * dataset shape) is sent to /api/code/chat so Hugh answers about the exact code in
 * front of the learner. A Code-mode composer (CodeMirror) lets them write a
 * snippet in their question, and any message can be pinned to the current card.
 */
export default function CodeChat({
  open,
  onOpenChange,
  focusCard = null,
  datasetLabel,
  langGuidance,
  lang = "python",
  onPin,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setInternalOpen(v));
  const canPin = !!(focusCard && onPin);
  const [messages, setMessages] = useState<Msg[]>([WELCOME]);
  const [draft, setDraft]       = useState("");
  const [code, setCode]         = useState("");
  const [codeMode, setCodeMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const [justPinned, setJustPinned] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading, isOpen]);

  // What Hugh needs to answer about THIS drill rather than guessing.
  function buildContext(): string {
    // Say nothing about the data unless the caller actually has some, and let
    // the drill supply the language guidance. A hardcoded "it is a plain Python
    // list of dicts, answer with standard-library Python" used to be sent on
    // every SQL and pandas drill too, where it was simply untrue.
    const parts: string[] = [];
    if (datasetLabel) parts.push(`The data is ${datasetLabel}.`);
    if (langGuidance) parts.push(langGuidance);
    if (focusCard) parts.push(`Current step — task: "${focusCard.task}". The reference solution is:\n${focusCard.solution}`);
    return parts.join("\n");
  }

  async function send() {
    const text = codeMode ? codeFence(code, lang) : draft.trim();
    if (!text || loading) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/code/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Drop the synthetic welcome so the transcript starts with a user turn.
        body: JSON.stringify({ messages: recentTextMessages(next.slice(1), 12), context: buildContext() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages(messages);
        setError(data.error ?? "Unable to send. Please try again.");
        return;
      }
      setMessages(m => [...m, { role: "assistant", content: data.reply ?? "Please try again." }]);
      setDraft(current => current === draft ? "" : current);
      setCode(current => current === code ? "" : current);
      setCodeMode(false);
    } catch {
      setMessages(messages);
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function pin(i: number, text: string) {
    if (!focusCard || !onPin) return;
    onPin(focusCard.id, text);
    setJustPinned(i);
    window.setTimeout(() => setJustPinned(p => (p === i ? null : p)), 1400);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }
  function onCodeKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); }
  }

  const shortTask = focusCard ? focusCard.task.replace(/^Create\s+/, "").split("—")[0].trim() : "";

  return (
    <>
      {isOpen && (
        <div className="fixed bottom-24 right-5 z-[60] flex h-[520px] w-[92vw] max-w-[380px] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-[#0d1424] shadow-2xl">
          <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <Image src="/hugh-icon.png" alt="Hugh" width={22} height={22} className="rounded-full" />
              <span className="text-sm font-semibold text-slate-100">Hugh</span>
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">coding helper</span>
            </div>
            <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-200">
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.map((m, i) => (
              <div key={i} className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}>
                <div className={`flex w-full ${m.role === "user" ? "justify-end" : "justify-start gap-2"}`}>
                  {m.role === "assistant" && (
                    <Image src="/hugh-icon.png" alt="" width={22} height={22} className="mt-0.5 h-[22px] w-[22px] shrink-0 rounded-full" />
                  )}
                  <div className={`max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                    m.role === "user"
                      ? "rounded-br-sm bg-sky-600 text-white"
                      : "rounded-tl-sm border border-slate-700 bg-slate-800/70 text-slate-200"
                  }`}>
                    <RichText text={m.content} />
                  </div>
                </div>
                {i !== 0 && canPin && (
                  <button
                    onClick={() => pin(i, m.content)}
                    className={`mt-1 flex items-center gap-1 px-1 text-[10px] transition-colors ${
                      justPinned === i ? "text-emerald-400" : "text-slate-600 hover:text-sky-300"
                    } ${m.role === "user" ? "self-end" : "self-start pl-8"}`}
                    title={`Pin this to “${shortTask}”`}
                  >
                    {justPinned === i ? <><Check size={10} /> pinned</> : <><Pin size={10} /> pin to “{shortTask}”</>}
                  </button>
                )}
              </div>
            ))}
            {error && <p role="alert" className="text-sm text-amber-300">{error}</p>}
            {loading && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 size={13} className="animate-spin" /> Hugh is thinking…
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="shrink-0 border-t border-slate-800 p-2.5">
            {focusCard && (
              <div className="mb-2 flex items-center gap-1.5 text-[11px] text-slate-500">
                <span className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 font-medium text-sky-300/80">On this step</span>
                <span className="truncate">{shortTask}</span>
              </div>
            )}

            {codeMode ? (
              <div onKeyDown={onCodeKey} className="overflow-hidden rounded-xl border border-violet-500/40 focus-within:border-violet-500">
                <div className="flex items-center justify-between border-b border-slate-700/70 bg-violet-500/5 px-2.5 py-1 text-[11px] font-semibold text-violet-300">
                  <span className="flex items-center gap-1"><Code2 size={12} /> Code mode · Python</span>
                  <button onClick={() => setCodeMode(false)} className="flex items-center gap-1 text-slate-500 hover:text-slate-300">
                    <Type size={11} /> Text
                  </button>
                </div>
                <div className="h-32 overflow-auto bg-[#0d1424]">
                  <CmEditor value={code} onChange={setCode} fontSize={12} />
                </div>
                <div className="flex items-center justify-between border-t border-slate-700/70 px-2.5 py-1.5">
                  <span className="text-[10px] text-slate-600">⌘/Ctrl+Enter to send · Tab indents</span>
                  <button
                    onClick={send}
                    disabled={!code.trim() || loading}
                    className="flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
                  >
                    <Send size={12} /> Send code
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-end gap-2 rounded-xl border border-slate-700 bg-slate-900 px-2.5 py-2 focus-within:border-sky-500">
                <button
                  onClick={() => setCodeMode(true)}
                  title="Write code in your question"
                  className="mb-0.5 shrink-0 text-slate-500 hover:text-violet-300"
                >
                  <Code2 size={16} />
                </button>
                <textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={onKey}
                  rows={1}
                  placeholder="Ask about the code…"
                  className="max-h-24 flex-1 resize-none bg-transparent text-sm text-slate-100 placeholder-slate-600 focus:outline-none"
                />
                <button
                  onClick={send}
                  disabled={!draft.trim() || loading}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40"
                >
                  <Send size={13} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floating Hugh bubble */}
      <button
        onClick={() => setOpen(!isOpen)}
        aria-label="Open Hugh coding helper"
        className="fixed bottom-5 right-5 z-[60] flex h-14 w-14 items-center justify-center rounded-full border border-slate-700 bg-[#0d1424] shadow-xl transition-transform hover:scale-105"
      >
        {isOpen ? (
          <X size={22} className="text-slate-300" />
        ) : (
          <Image src="/hugh-icon.png" alt="Hugh" width={40} height={40} className="rounded-full" />
        )}
      </button>
    </>
  );
}

/** Minimal markdown: fenced code blocks + inline `code` / **bold**. */
export function RichText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0, m: RegExpExecArray | null, key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Prose key={key++} text={text.slice(last, m.index)} />);
    parts.push(
      <pre key={key++} className="my-1.5 overflow-x-auto rounded-lg border border-slate-700 bg-slate-950/70 p-2.5 font-mono text-[12px] leading-relaxed text-sky-200/90">
        {m[2].replace(/\n$/, "")}
      </pre>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<Prose key={key++} text={text.slice(last)} />);
  return <>{parts}</>;
}

function Prose({ text }: { text: string }) {
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*|`([^`]+?)`)/g;
  let last = 0, m: RegExpExecArray | null, key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) nodes.push(<strong key={key++} className="font-semibold text-slate-100">{m[2]}</strong>);
    else nodes.push(<code key={key++} className="rounded bg-slate-700/60 px-1 py-0.5 font-mono text-[12px] text-sky-200/90">{m[3]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <span className="whitespace-pre-wrap">{nodes}</span>;
}
