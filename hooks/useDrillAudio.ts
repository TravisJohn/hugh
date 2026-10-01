"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FOCUS_TRACKS } from "@/lib/pomodoro/tracks";

// Escalating hype lines are prerecorded files in public/audio/hype.
// Playback makes no provider request.
const HYPE_BY_COMBO: string[] = ["nice", "great", "great", "fire", "fire", "unstoppable"];
const EXTRA_LINES = ["boom", "rolling"];

/**
 * Ramp an audio element's volume to zero over `ms`, then pause it. The element
 * is a detached HTMLAudioElement, so it keeps playing (and fading) even after
 * the component that owned it unmounts — which is exactly what lets the music
 * fade out gracefully when the user hits Back instead of cutting off abruptly.
 */
function fadeOutAndPause(el: HTMLAudioElement, ms = 450) {
  const startVol = el.volume;
  const steps = 24;
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    el.volume = Math.max(0, startVol * (1 - i / steps));
    if (i >= steps) {
      clearInterval(timer);
      el.pause();
      el.volume = startVol; // restore in case the element is ever reused
    }
  }, ms / steps);
}

/**
 * Throwaway-mock audio: a synth "chime" (WebAudio, no asset) that rises in pitch
 * with the combo, a spoken hype line per correct cell, and looping background
 * music reused from the Pomodoro focus tracks. All gated behind a first user
 * gesture (the browser blocks autoplay until then).
 */
export function useDrillAudio() {
  const acRef = useRef<AudioContext | null>(null);
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const [musicOn, setMusicOn] = useState(true);
  const [soundOn, setSoundOn] = useState(true);
  const soundOnRef = useRef(true);
  useEffect(() => { soundOnRef.current = soundOn; }, [soundOn]);

  useEffect(() => {
    if (FOCUS_TRACKS.length === 0) return;
    // Play THROUGH the playlist and wrap around, rather than looping one track
    // over and over. Start at a random track for variety between sessions.
    let idx = (Math.random() * FOCUS_TRACKS.length) | 0;
    const el = new Audio(FOCUS_TRACKS[idx]);
    el.volume = 0.22;
    const onEnded = () => {
      idx = (idx + 1) % FOCUS_TRACKS.length;
      el.src = FOCUS_TRACKS[idx];
      el.play().catch(() => {});
    };
    el.addEventListener("ended", onEnded);
    musicRef.current = el;
    return () => { el.removeEventListener("ended", onEnded); fadeOutAndPause(el); musicRef.current = null; };
  }, []);

  /** Call once from a click so audio is unlocked. */
  const unlock = useCallback(() => {
    if (!acRef.current) {
      try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        acRef.current = new Ctor();
      } catch { /* no webaudio */ }
    }
    void acRef.current?.resume();
    if (musicOn) musicRef.current?.play().catch(() => {});
  }, [musicOn]);

  // Subtle mechanical-keyboard click per keystroke (aesthetic).
  const click = useCallback(() => {
    const ac = acRef.current;
    if (!ac || !soundOnRef.current) return;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = "square";
    osc.frequency.value = 1500 + Math.random() * 500;
    const t = ac.currentTime;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.04);
  }, []);

  const chime = useCallback((combo: number) => {
    const ac = acRef.current;
    if (!ac || !soundOnRef.current) return;
    const base = 440 * Math.pow(2, Math.min(combo, 8) / 12); // step up a semitone per combo
    [0, 4, 7].forEach((semi, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "triangle";
      osc.frequency.value = base * Math.pow(2, semi / 12);
      const t = ac.currentTime + i * 0.06;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  }, []);

  const speak = useCallback((combo: number) => {
    if (!soundOnRef.current) return;
    const name = combo >= 6 && Math.random() < 0.5
      ? EXTRA_LINES[(Math.random() * EXTRA_LINES.length) | 0]
      : HYPE_BY_COMBO[Math.min(combo, HYPE_BY_COMBO.length - 1)];
    if (!name || name === "nice") return; // no low-tier "nice" line — too repetitive
    const a = new Audio(`/audio/hype/${name}.mp3`);
    a.volume = 0.9;
    a.play().catch(() => {});
  }, []);

  /** Celebrate a correct cell: chime + voice, intensity from the combo. */
  const celebrate = useCallback((combo: number) => {
    chime(combo);
    speak(combo);
  }, [chime, speak]);

  const toggleMusic = useCallback(() => {
    setMusicOn(on => {
      const next = !on;
      const el = musicRef.current;
      if (el) { if (next) el.play().catch(() => {}); else el.pause(); }
      return next;
    });
  }, []);

  const toggleSound = useCallback(() => setSoundOn(s => !s), []);

  return { unlock, celebrate, click, musicOn, toggleMusic, soundOn, toggleSound };
}
