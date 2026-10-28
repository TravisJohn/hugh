"use client";

import { useState } from "react";
import Link from "next/link";
import { GraduationCap, Rocket, Trophy, LogIn, UserPlus } from "lucide-react";
import type { LucideIcon } from "lucide-react";

type CardId = "learn" | "apply" | "show";

/**
 * The three public pillars. Each maps to shipped surfaces behind auth:
 * Learn → /home/learn, Apply → /code/start + /cloud, Show → /cases.
 *
 * Tailwind can't see dynamically-built class names, so every accent class is
 * written out in full here rather than composed from a colour token.
 */
type PlatformCard = {
  id:      CardId;
  icon:    LucideIcon;
  title:   string;
  blurb:   string;
  cta:     string;
  accent: {
    activeBorder: string;
    idleBorder:   string;
    shadow:       string;
    gradient:     string;
    iconChip:     string;
    badge:        string;
    dot:          string;
    cta:          string;
  };
};

const PLATFORM_CARDS: PlatformCard[] = [
  {
    id:    "learn",
    icon:  GraduationCap,
    title: "Learn",
    blurb:
      "Follow an AI-mapped track, ask Hugh anything on your topic, and practise " +
      "out loud — everything you need to actually know your stuff.",
    cta:   "Start learning",
    accent: {
      activeBorder: "border-green-500/40 shadow-green-500/10",
      idleBorder:   "border-slate-700/50 hover:border-green-500/40 hover:shadow-green-500/10",
      shadow:       "shadow-green-500/10",
      gradient:     "from-green-500/5",
      iconChip:     "bg-green-400/10 text-green-400",
      badge:        "bg-green-500/15 text-green-400",
      dot:          "bg-green-400",
      cta:          "text-green-400",
    },
  },
  {
    id:    "apply",
    icon:  Rocket,
    title: "Apply",
    blurb:
      "Turn what you know into reps — short, timed coding drills that build " +
      "muscle memory, plus a map of the cloud services data work runs on.",
    cta:   "Start applying",
    accent: {
      activeBorder: "border-sky-500/40 shadow-sky-500/10",
      idleBorder:   "border-slate-700/50 hover:border-sky-500/40 hover:shadow-sky-500/10",
      shadow:       "shadow-sky-500/10",
      gradient:     "from-sky-500/5",
      iconChip:     "bg-sky-400/10 text-sky-400",
      badge:        "bg-sky-500/15 text-sky-400",
      dot:          "bg-sky-400",
      cta:          "text-sky-400",
    },
  },
  {
    id:    "show",
    icon:  Trophy,
    title: "Show",
    blurb:
      "Prove it on real business cases — make the calls that matter in The Case " +
      "Room, then test your judgment against an expert's.",
    cta:   "Show what you know",
    accent: {
      activeBorder: "border-amber-500/40 shadow-amber-500/10",
      idleBorder:   "border-slate-700/50 hover:border-amber-500/40 hover:shadow-amber-500/10",
      shadow:       "shadow-amber-500/10",
      gradient:     "from-amber-500/5",
      iconChip:     "bg-amber-400/10 text-amber-400",
      badge:        "bg-amber-500/15 text-amber-400",
      dot:          "bg-amber-400",
      cta:          "text-amber-400",
    },
  },
];

export default function FeatureCards() {
  // Which card has revealed its auth buttons — only one at a time.
  const [active, setActive] = useState<CardId | null>(null);

  const authButtons = (
    <div className="flex flex-col gap-2 pt-1">
      <Link
        href="/login"
        onClick={e => e.stopPropagation()}
        className="flex items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-500"
      >
        <LogIn size={13} />
        Sign in
      </Link>
      <Link
        href="/signup"
        onClick={e => e.stopPropagation()}
        className="flex items-center justify-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 transition-colors hover:border-slate-400 hover:text-white"
      >
        <UserPlus size={13} />
        Sign up
      </Link>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {PLATFORM_CARDS.map(({ id, icon: Icon, title, blurb, cta, accent }) => {
        const isActive = active === id;
        return (
          <div
            key={id}
            onClick={() => setActive(prev => (prev === id ? null : id))}
            className={`group relative overflow-hidden rounded-2xl border bg-slate-800/30 p-6 cursor-pointer select-none transition-all duration-300 hover:-translate-y-1 hover:bg-slate-800/60 hover:shadow-xl
              ${isActive
                ? `${accent.activeBorder} bg-slate-800/60 -translate-y-1 shadow-xl`
                : accent.idleBorder
              }`}
          >
            <div className={`pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br ${accent.gradient} to-transparent transition-opacity duration-300 ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`} />
            <div className="relative">
              <div className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl ${accent.iconChip} transition-transform duration-300 ${isActive ? "scale-110" : "group-hover:scale-110"}`}>
                <Icon className="h-5 w-5" />
              </div>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-semibold text-white">{title}</span>
                <span className={`flex items-center gap-1 rounded-full ${accent.badge} px-2 py-0.5 text-xs`}>
                  <span className={`h-1.5 w-1.5 animate-pulse rounded-full ${accent.dot}`} />
                  Live
                </span>
              </div>
              <p className="mb-4 text-sm leading-relaxed text-slate-400">
                {blurb}
              </p>
              {isActive ? authButtons : (
                <span className={`inline-flex items-center gap-1 text-sm font-medium ${accent.cta} transition-all group-hover:gap-2`}>
                  {cta} <span className="transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
