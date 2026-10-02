"use client";

import { ArrowUpRight } from "lucide-react";
import { type GroupProgress } from "@/lib/learn/constellation";
import { type InFlightGoal } from "@/lib/learn/progress";
import { LEARNING_REGIONS } from "@/lib/learn/regions";

interface Props {
  progress: GroupProgress | null;
  inFlight: readonly InFlightGoal[];
  onChooseTopic: (topic: string) => void;
}

const STARTING_POINTS: Readonly<Record<string, { topic: string; description: string }>> = {
  ml: {
    topic: "Model evaluation",
    description: "Data science, models and the decisions behind them",
  },
  stats: {
    topic: "Experiment design",
    description: "Evidence, uncertainty and causal thinking",
  },
  engineering: {
    topic: "Dimensional modelling",
    description: "Reliable structures and movement of data",
  },
  cloud: {
    topic: "Cloud data warehouses",
    description: "Platforms, scale and the cost of a query",
  },
  automation: {
    topic: "Data pipeline orchestration",
    description: "Workflows that run, recover and stay observable",
  },
  analytics: {
    topic: "Cohort analysis",
    description: "Questions, measures and clear explanations",
  },
};

export default function LearningFieldGuide({ progress, inFlight, onChooseTopic }: Props) {
  return (
    <div className="mx-auto flex h-full w-full max-w-[52rem] flex-col px-2 pt-1">
      <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
        <span className="h-px w-7 bg-amber-400/70" />
        Hugh / Learn
      </div>
      <h2 className="mt-5 max-w-xl text-[clamp(1.55rem,2vw,2.15rem)] font-semibold leading-tight tracking-tight text-slate-100">
        A focused place to get better with data.
      </h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-400">
        Explore a starting point below, or bring your own topic. Hugh helps you build the ideas behind the work.
      </p>

      <div className="mt-7 grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-700/70">
        {LEARNING_REGIONS.map((region, index) => {
          const startingPoint = STARTING_POINTS[region.id];
          if (!startingPoint) return null;
          const mastered = progress?.[region.id];
          const activeCount = inFlight.filter(goal => goal.region === region.id).length;

          return (
            <div key={region.id} className="flex min-h-[8.15rem] flex-col bg-[#111c30] px-5 py-4 transition-colors hover:bg-[#18253b]">
              <div className="flex items-start justify-between gap-3">
                <span className="font-mono text-[10px] tracking-widest text-slate-600">
                  {String(index + 1).padStart(2, "0")}
                </span>
                {activeCount > 0 ? (
                  <span className="text-[10px] font-medium text-slate-400">
                    {activeCount} active {activeCount === 1 ? "track" : "tracks"}
                  </span>
                ) : typeof mastered === "number" && mastered > 0 ? (
                  <span className="text-[10px] font-medium text-slate-400">
                    {Math.round(mastered * 100)}% mastered
                  </span>
                ) : null}
              </div>
              <h3 className="mt-2 text-sm font-semibold tracking-tight text-slate-100">
                {region.label}
              </h3>
              <p className="mt-0.5 text-xs leading-snug text-slate-500">
                {startingPoint.description}
              </p>
              <button
                type="button"
                onClick={() => onChooseTopic(startingPoint.topic)}
                className="mt-auto flex w-fit items-center gap-1.5 pt-2.5 text-xs font-medium text-amber-200/85 transition-colors hover:text-amber-100 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
                aria-label={`Start with ${startingPoint.topic}`}
              >
                {startingPoint.topic}
                <ArrowUpRight size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      <p className="mt-5 text-xs leading-relaxed text-slate-500">
        Hugh checks each topic before building a track. Tool topics are welcome; the learning focuses on the concepts behind them.
      </p>
    </div>
  );
}
