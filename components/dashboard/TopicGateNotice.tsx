"use client";

import { AlertTriangle, Pencil, Sparkles } from "lucide-react";
import { type TopicDomainVerdict } from "@/lib/learn/topic-domain";

interface Props {
  verdict: TopicDomainVerdict;
  /** Fills the topic field with a chosen angle. Omit where no field exists. */
  onPickSuggestion?: (suggestion: string) => void;
  /**
   * Hands the learner back to the topic field to phrase their own angle.
   * Rendered only for `needs_angle` — see the note below on why not elsewhere.
   * Omit where no field exists.
   */
  onWriteOwn?: () => void;
}

// The one place the topic gate speaks to a learner. Shared by the typed-topic
// panel and the document flow so the two cannot drift into saying different
// things about the same verdict.
//
// It renders three outcomes, and the difference is the point:
//
//   needs_angle — Hugh is asking a question. No warning colour, no warning
//                 icon, and copy that never suggests the topic is off-limits,
//                 because it isn't. The suggestions are the answers.
//   out         — Hugh is declining, kindly, and finally. Warning treatment,
//                 no suggestions: a decline that offers a data version of the
//                 learner's subject reads as a pitch, not an answer.
//   unavailable — the classifier made no call. The learner can retry unchanged.
//
// Rendering the first as the second is the bug this component exists to stop:
// it is what told someone typing "Generative AI" that their topic sat outside
// a data & analytics app, then offered them "Machine learning engineering
// fundamentals" as consolation.
//
// The same split decides who gets "describe it myself". Under `needs_angle`
// Hugh has asked a question, and phrasing your own answer is a legitimate one —
// chips under an imperative heading otherwise read as the only options there
// are. Under `out` Hugh has made its call, and an invitation to reword is an
// invitation to keep trying until something slips through. The topic field
// stays editable either way; what changes is whether Hugh suggests using it.
export default function TopicGateNotice({ verdict, onPickSuggestion, onWriteOwn }: Props) {
  if (verdict.verdict === "in") return null;

  const asking = verdict.verdict === "needs_angle";
  const unavailable = verdict.verdict === "unavailable";

  const fallbackMessage = asking
    ? "That topic covers a lot of ground — which part are you after?"
    : unavailable
    ? "Hugh couldn't check this topic right now. Please try again."
    : "Hugh is built specifically for data & analytics skill prep — that topic sits outside this focus.";

  // Chips belong to the question, not to the decline. A declined topic returns
  // no suggestions from the judge; this guard means a model that emits some
  // anyway cannot turn a respectful "no" back into a pitch.
  const showChips = asking && verdict.suggestions.length > 0 && !!onPickSuggestion;
  const showOwn   = asking && !!onWriteOwn;

  return (
    <div
      className={
        asking
          ? "rounded-xl border border-slate-700 bg-slate-800/50 p-4"
          : "rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
      }
    >
      <div className="flex items-start gap-2.5">
        {asking ? (
          <Sparkles size={16} className="mt-0.5 shrink-0 text-amber-400" />
        ) : (
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-400" />
        )}
        <div className="space-y-2.5">
          <p className="text-sm leading-relaxed text-slate-200">
            {verdict.message || fallbackMessage}
          </p>

          {(showChips || showOwn) && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-500">Pick an angle</p>
              <div className="flex flex-wrap gap-2">
                {showChips && verdict.suggestions.map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onPickSuggestion?.(s)}
                    className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-200 hover:bg-amber-500/20 transition-colors"
                  >
                    {s}
                  </button>
                ))}

                {/* Deliberately not styled as a fourth suggestion — dashed and
                    grey, because it is a different kind of thing: an answer the
                    learner writes, not one Hugh proposed. */}
                {showOwn && (
                  <button
                    type="button"
                    onClick={onWriteOwn}
                    className="flex items-center gap-1 rounded-full border border-dashed border-slate-600 px-3 py-1 text-xs text-slate-400 hover:border-slate-400 hover:text-slate-200 transition-colors"
                  >
                    <Pencil size={11} />
                    Something else — I&apos;ll describe it
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
