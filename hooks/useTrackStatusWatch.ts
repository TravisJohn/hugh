"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { type TrackStatus } from "@/types";

/**
 * Why the watch ended without a board. 'failed' is the build's own stored
 * verdict. 'timeout' is only the watcher giving up: the build may still be
 * running, and the retry route refuses a rebuild until the stall window has
 * passed, so a caller that offers Rebuild must not treat the two alike.
 */
export type WatchFailure = "failed" | "timeout";

interface Options {
  goalId:     string | null;
  active:     boolean;
  onReady:    () => void;
  onFailed:   (reason: WatchFailure) => void;
  timeoutMs?: number;
}

// Watches a learning_goal's track_status until it settles to 'ready' or
// 'failed'. Realtime is the fast path, but it silently drops events on
// RLS-protected tables when the socket isn't authed, so it can NOT be the
// only mechanism — a 3s poll guarantees the transition, and a hard timeout
// guarantees the caller never hangs forever (e.g. if a background build is
// killed before it writes a final status). Shared by RefinementFlow (Q&A
// path), DocumentUploadFlow (document path) and GoalCard (a course started
// from the catalog, or a rebuild) — all watch the exact same state machine
// once generateTrack fires (PRD-course-from-document.md §7.1).
export function useTrackStatusWatch({ goalId, active, onReady, onFailed, timeoutMs = 180_000 }: Options) {
  // Guards a single terminal transition — Realtime + the poll can both fire,
  // but the caller must only be notified once.
  const settledRef = useRef(false);

  useEffect(() => {
    if (!active || !goalId) return;
    settledRef.current = false;

    const supabase = createClient();
    let pollId:    ReturnType<typeof setInterval> | null = null;
    let timeoutId: ReturnType<typeof setTimeout>  | null = null;

    const channel = supabase
      .channel(`goal-${goalId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "learning_goals", filter: `id=eq.${goalId}` },
        payload => settle((payload.new as { track_status?: TrackStatus }).track_status),
      )
      .subscribe();

    const cleanup = () => {
      if (pollId)    clearInterval(pollId);
      if (timeoutId) clearTimeout(timeoutId);
      void supabase.removeChannel(channel);
    };

    function settle(status: TrackStatus | undefined) {
      if (settledRef.current) return;
      if (status === "ready") {
        settledRef.current = true;
        cleanup();
        onReady();
      } else if (status === "failed") {
        settledRef.current = true;
        cleanup();
        onFailed("failed");
      }
    }

    const checkNow = () => {
      void supabase
        .from("learning_goals")
        .select("track_status")
        .eq("id", goalId)
        .single()
        .then(({ data }) => settle(data?.track_status as TrackStatus | undefined));
    };

    // Authenticate the realtime socket so RLS-protected changes are delivered.
    void supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
    });

    // Reliable path: immediate check + poll until the build settles.
    checkNow();
    pollId = setInterval(checkNow, 3000);

    // Hard safety net: never hang. If nothing has settled after the build
    // window, surface a failure instead of an endless "Building…".
    timeoutId = setTimeout(() => {
      if (!settledRef.current) {
        settledRef.current = true;
        cleanup();

        // The beacon fires on THIS path only. Reaching the timeout means the
        // build wrote no status at all — the after() invocation was killed and
        // cannot report its own death, so the browser is the only witness. A
        // status of 'failed' arriving through settle() is already recorded
        // server-side; beaconing that too would double-count it.
        //
        // keepalive so the report survives the learner closing the tab, and
        // deliberately unawaited: telling the user comes first.
        void fetch("/api/observability/beacon", {
          method:    "POST",
          headers:   { "Content-Type": "application/json" },
          body:      JSON.stringify({ operation: "track.build", goalId, waitedMs: timeoutMs }),
          keepalive: true,
        }).catch(() => {
          // Observability must never break what it observes — least of all in
          // the browser, where a failed report would otherwise surface as an
          // unhandled rejection on top of the failure the learner already has.
        });

        onFailed("timeout");
      }
    }, timeoutMs);

    return cleanup;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, goalId]);
}
