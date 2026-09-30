"use client";

import { recentTextMessages } from "@/lib/claude/textInput";

import { useRef, useState } from "react";
import { Sparkles, Send } from "lucide-react";
import type { CloudProvider } from "@/types/cloud";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

/**
 * The scoped assistant that lives beside a service write-up. It knows which
 * service you're looking at (provider + id are sent with every turn); the server
 * route injects that service's facts into the system prompt so answers stay
 * grounded and on-domain. Haiku, usage-gated — see app/api/cloud/chat.
 */
export default function CloudAssistant({
  provider,
  serviceId,
  serviceName,
}: {
  provider: CloudProvider;
  serviceId: string;
  serviceName: string;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const suggestions = [
    `When would I choose ${serviceName}?`,
    `What are the common mistakes?`,
    `How does it compare on the other clouds?`,
  ];

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const next: Msg[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput(trimmed);
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/cloud/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, serviceId, messages: recentTextMessages(next, 12) }),
      });
      const data = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok) {
        setMessages(messages);
        setError(data.error ?? "Something went wrong. Please try again.");
      } else {
        setInput(current => current === trimmed ? "" : current);
        setMessages([...next, { role: "assistant", content: data.reply ?? "" }]);
      }
    } catch {
      setMessages(messages);
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }
  }

  return (
    <div className="flex h-[28rem] flex-col rounded-2xl border border-slate-800 bg-slate-900/40">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <Sparkles size={15} className="text-violet-400" />
        <span className="text-sm font-semibold text-slate-200">Ask about {serviceName}</span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">
              Ask anything about {serviceName} — trade-offs, gotchas, or how it maps to
              the other clouds.
            </p>
            <div className="flex flex-col gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-left text-xs text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-200"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={`rounded-xl px-3 py-2 text-sm leading-relaxed ${
              m.role === "user"
                ? "ml-6 bg-violet-500/15 text-slate-100"
                : "mr-2 bg-slate-800/60 text-slate-300"
            }`}
          >
            {m.content}
          </div>
        ))}

        {loading && (
          <div className="mr-2 rounded-xl bg-slate-800/60 px-3 py-2 text-sm text-slate-500">
            Thinking…
          </div>
        )}
        {error && (
          <div className="rounded-xl bg-rose-900/20 px-3 py-2 text-sm text-rose-300">
            {error}
          </div>
        )}
      </div>

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex items-center gap-2 border-t border-slate-800 p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question…"
          className="min-w-0 flex-1 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          aria-label="Send"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/20 text-violet-300 transition-colors hover:bg-violet-500/30 disabled:opacity-40"
        >
          <Send size={15} />
        </button>
      </form>
    </div>
  );
}
