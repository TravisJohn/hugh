"use client";

import { useRef, useState } from "react";
import { ListChecks } from "lucide-react";
import ChatWindow from "./ChatWindow";
import ChecklistRail from "./ChecklistRail";

interface Props {
  topic:           string;
  goalId:          string;
  milestoneId?:    string;
  milestoneTitle?: string;
}

/**
 * Ask page layout: chat on the left, the persistent goal checklist on the right.
 * The checklist is a self-assessment the learner ticks off manually — it does
 * not depend on the chat, so the two panes are independent.
 */
export default function AskWorkspace({ topic, goalId, milestoneId, milestoneTitle }: Props) {
  // Bridge between the two independent panes: the rail calls this to drop a
  // learning point into the chat composer, which registers the handler.
  const insertRef = useRef<((text: string) => void) | null>(null);
  const [mobileChecklistOpen, setMobileChecklistOpen] = useState(false);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
      {milestoneId && milestoneTitle && (
        <button
          type="button"
          onClick={() => setMobileChecklistOpen(true)}
          className="flex min-h-11 shrink-0 items-center gap-2 border-b border-slate-800 px-4 text-sm font-medium text-sky-300 lg:hidden"
        >
          <ListChecks size={16} /> What to understand
        </button>
      )}
      <ChatWindow
        topic={topic}
        goalId={goalId}
        milestoneId={milestoneId}
        milestoneTitle={milestoneTitle}
        insertRef={insertRef}
      />

      {milestoneId && milestoneTitle && (
        <>
          {mobileChecklistOpen && (
            <button
              type="button"
              aria-label="Close checklist"
              onClick={() => setMobileChecklistOpen(false)}
              className="fixed inset-0 z-30 bg-black/60 lg:hidden"
            />
          )}
          <ChecklistRail
            milestoneId={milestoneId}
            milestoneTitle={milestoneTitle}
            mobileOpen={mobileChecklistOpen}
            onClose={() => setMobileChecklistOpen(false)}
            onInsertToPrompt={text => { insertRef.current?.(text); setMobileChecklistOpen(false); }}
          />
        </>
      )}
    </div>
  );
}
