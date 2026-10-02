'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MasteryRealtimeSession } from '@/lib/mastery/realtimeSession';
import { followupCapReached } from '@/lib/mastery/caps';
import type {
  MasteryRealtimeStatus,
  MasteryRealtimeError,
  MasteryTranscriptTurn,
  MasteryEndReason,
} from '@/types';

interface UseMasteryRealtimeReturn {
  status:     MasteryRealtimeStatus;
  error:      MasteryRealtimeError | null;
  transcript: MasteryTranscriptTurn[];
  endReason:  MasteryEndReason | null;   // set once the session concludes
  connect:    (milestoneId: string) => Promise<boolean>;
  endByUser:  () => void;
  disconnect: () => void;
}

export function useMasteryRealtime(): UseMasteryRealtimeReturn {
  const [status,     setStatus]     = useState<MasteryRealtimeStatus>('idle');
  const [error,      setError]      = useState<MasteryRealtimeError | null>(null);
  const [transcript, setTranscript] = useState<MasteryTranscriptTurn[]>([]);
  const [endReason,  setEndReason]  = useState<MasteryEndReason | null>(null);

  const sessionRef   = useRef<MasteryRealtimeSession | null>(null);
  const maxTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coachTurnsRef = useRef(0);
  const maxFollowupsRef = useRef(6);
  const inactivityMsRef = useRef(90_000);
  const endedRef = useRef(false); // single-evaluation guard

  const endRequestedRef = useRef(false);

  const requestServerEnd = useCallback((reason: MasteryEndReason | 'disconnected', useBeacon: boolean) => {
    const sessionId = sessionRef.current?.getSessionId();
    if (!sessionId || endRequestedRef.current) return;
    endRequestedRef.current = true;
    const body = JSON.stringify({ sessionId, reason });
    const url = '/api/tracker/mastery/realtime-end';
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    } else {
      void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (maxTimerRef.current)  { clearTimeout(maxTimerRef.current);  maxTimerRef.current  = null; }
    if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
  }, []);

  // Single, idempotent end path. First reason wins; further triggers are ignored.
  const endSession = useCallback((reason: MasteryEndReason) => {
    if (endedRef.current) return;
    endedRef.current = true;
    clearTimers();
    requestServerEnd(reason, false);
    sessionRef.current?.dispose();
    setEndReason(reason);
    setStatus('concluding');
  }, [clearTimers, requestServerEnd]);

  const bumpIdle = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => endSession('inactivity'), inactivityMsRef.current);
  }, [endSession]);

  const disconnect = useCallback(() => {
    clearTimers();
    requestServerEnd('disconnected', true);
    sessionRef.current?.dispose();
    sessionRef.current = null;
  }, [clearTimers, requestServerEnd]);

  const connect = useCallback(async (milestoneId: string): Promise<boolean> => {
    disconnect();
    endRequestedRef.current = false;
    endedRef.current = false;
    coachTurnsRef.current = 0;
    setError(null);
    setEndReason(null);
    setTranscript([]);
    setStatus('connecting');

    const session = new MasteryRealtimeSession({
      onStatus: (s) => { if (sessionRef.current === session) setStatus(s); },
      onError:  (e) => { if (sessionRef.current === session) setError(e); },
      onTranscript: (t) => {
        if (sessionRef.current !== session) return;
        setTranscript(t);
        bumpIdle();
      },
      onCoachTurn: () => {
        if (sessionRef.current !== session) return;
        coachTurnsRef.current += 1;
        if (followupCapReached(coachTurnsRef.current, maxFollowupsRef.current)) {
          endSession('max_followups');
        }
      },
      onConclude: () => {
        if (sessionRef.current === session) endSession('coach_concluded');
      },
    });
    sessionRef.current = session;

    const creds = await session.connect(milestoneId);
    if (sessionRef.current !== session) return false;
    if (!creds) return false;

    maxFollowupsRef.current = creds.maxFollowups;
    inactivityMsRef.current = creds.inactivityMs;

    maxTimerRef.current = setTimeout(() => endSession('max_duration'), creds.maxSessionSeconds * 1000);
    bumpIdle();

    return session.getStatus() !== 'error';
  }, [disconnect, bumpIdle, endSession]);

  const endByUser = useCallback(() => endSession('user_ended'), [endSession]);

  useEffect(() => {
    const onUnload = () => disconnect();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      disconnect();
    };
  }, [disconnect]);

  return { status, error, transcript, endReason, connect, endByUser, disconnect };
}
