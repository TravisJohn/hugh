"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./LearningCuriosityCarousel.module.css";

interface Props {
  onChooseTopic: (topic: string) => void;
}

const SLIDES = [
  {
    topic: "Clustering",
    category: "Machine learning",
    title: "Why do some points belong together?",
    description: "Watch a loose field of observations find its own groups. What counts as similar changes the picture.",
  },
  {
    topic: "Reinforcement learning",
    category: "Machine learning",
    title: "Can a robot learn from a wrong turn?",
    description: "A missed reward sends it back through the maze. Each attempt changes the route it takes next.",
  },
  {
    topic: "Outlier detection",
    category: "Statistics · machine learning",
    title: "Which observation doesn’t fit?",
    description: "Most points share a pattern. One sits apart, waiting for someone to ask why.",
  },
] as const;

const CLUSTER_CENTRES = [
  { x: 170, y: 178, color: "#5eead4" },
  { x: 310, y: 105, color: "#a78bfa" },
  { x: 446, y: 188, color: "#fbbf24" },
] as const;

const round = (value: number) => Number(value.toFixed(2));

const CLUSTER_POINTS = Array.from({ length: 54 }, (_, index) => {
  const group = index % 3;
  const local = Math.floor(index / 3);
  const centre = CLUSTER_CENTRES[group]!;
  const angle = local * 2.39996 + group * 0.43;
  const radius = 11 + Math.sqrt((local + 1) / 18) * 57;
  const x = round(centre.x + Math.cos(angle) * radius);
  const y = round(centre.y + Math.sin(angle) * radius * 0.72);
  const startX = 64 + ((index * 83 + 19) % 490);
  const startY = 45 + ((index * 127 + 31) % 203);
  return {
    x, y, dx: round(startX - x), dy: round(startY - y),
    color: centre.color,
    delay: (local % 6) * 0.075,
    radius: local % 5 === 0 ? 3.5 : 2.5,
  };
});

const MAZE_OPEN = new Set([
  "0-0", "1-0", "2-0", "3-0",
  "1-1", "2-1", "3-1",
  "3-2",
  "3-3", "4-3", "5-3", "6-3",
  "6-4", "7-4",
]);

const OUTLIER_POINTS = Array.from({ length: 46 }, (_, index) => {
  const angle = index * 2.39996;
  const radius = 18 + Math.sqrt((index + 1) / 46) * 120;
  return {
    x: round(292 + Math.cos(angle) * radius * 1.14),
    y: round(165 + Math.sin(angle) * radius * 0.67),
    radius: index % 7 === 0 ? 3.5 : 2.6,
    delay: (index % 9) * -0.28,
  };
});

function ChartGrid() {
  return (
    <>
      <defs>
        <pattern id="learn-chart-grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <path d="M 28 0 L 0 0 0 28" fill="none" stroke="#36516b" strokeWidth="0.55" opacity="0.45" />
        </pattern>
      </defs>
      <rect width="620" height="300" fill="url(#learn-chart-grid)" opacity="0.55" />
      <path d="M52 35 V264 H574" fill="none" stroke="#66809b" strokeWidth="1" opacity="0.43" />
      <text x="56" y="27" fill="#7188a2" fontSize="9" letterSpacing="2">FEATURE 02</text>
    </>
  );
}

function ClusteringGraphic() {
  return (
    <svg viewBox="0 0 620 300" className={styles.graphic} aria-hidden="true">
      <ChartGrid />
      {CLUSTER_CENTRES.map((centre, index) => (
        <g key={index} className={styles.clusterRegion} style={{ animationDelay: `${index * 0.16}s` }}>
          <circle cx={centre.x} cy={centre.y} r="67" fill={centre.color} opacity="0.055" />
          <circle cx={centre.x} cy={centre.y} r="67" fill="none" stroke={centre.color} strokeWidth="1" strokeDasharray="3 7" opacity="0.3" />
        </g>
      ))}
      {CLUSTER_POINTS.map((point, index) => (
        <circle
          key={index}
          cx={point.x}
          cy={point.y}
          r={point.radius}
          fill={point.color}
          className={styles.clusterPoint}
          style={{
            "--dx": `${point.dx}px`,
            "--dy": `${point.dy}px`,
            "--delay": `${point.delay}s`,
          } as CSSProperties}
        />
      ))}
      {CLUSTER_CENTRES.map((centre, index) => (
        <text key={index} x={centre.x} y={centre.y + 82} textAnchor="middle" fill={centre.color} className={styles.clusterLabel}>
          GROUP {String.fromCharCode(65 + index)}
        </text>
      ))}
      <text x="565" y="27" textAnchor="end" fill="#8ca0b7" fontSize="9" letterSpacing="2">SIMILARITY → STRUCTURE</text>
    </svg>
  );
}

function MazeGraphic() {
  return (
    <svg viewBox="0 0 620 300" className={styles.graphic} aria-hidden="true">
      <defs>
        <radialGradient id="learn-maze-goal">
          <stop offset="0" stopColor="#fbbf24" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fbbf24" stopOpacity="0" />
        </radialGradient>
      </defs>
      <text x="566" y="23" textAnchor="end" fill="#8ca0b7" fontSize="9" letterSpacing="2">TRIAL 01 → TRIAL 02</text>
      {Array.from({ length: 5 }, (_, row) =>
        Array.from({ length: 8 }, (_, col) => {
          const open = MAZE_OPEN.has(`${col}-${row}`);
          return (
            <rect
              key={`${col}-${row}`}
              x={120 + col * 48}
              y={30 + row * 48}
              width="46"
              height="46"
              rx="6"
              fill={open ? "#18334a" : "#101c2d"}
              stroke={open ? "#35546b" : "#26374b"}
              strokeWidth="0.8"
            />
          );
        }),
      )}
      <path d="M144 54 H288" fill="none" stroke="#fb7185" strokeWidth="3" strokeLinecap="round" strokeDasharray="5 7" className={styles.failedRoute} />
      <path d="M144 54 H192 V102 H288 V198 H432 V246 H480" fill="none" stroke="#5eead4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={styles.successRoute} />
      <circle cx="480" cy="246" r="37" fill="url(#learn-maze-goal)" className={styles.goalGlow} />
      <rect x="470" y="236" width="20" height="20" rx="5" fill="#fbbf24" />
      <path d="M476 246 l3 3 6-7" fill="none" stroke="#101827" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <g className={styles.robot}>
        <circle r="16" fill="#6ee7f0" opacity="0.13" />
        <circle r="10" fill="#73e0eb" stroke="#d5fbff" strokeWidth="1.5" />
        <circle cx="-3" cy="-1" r="1.2" fill="#0b2639" />
        <circle cx="3" cy="-1" r="1.2" fill="#0b2639" />
        <path d="M-3 3 Q0 5 3 3" fill="none" stroke="#0b2639" strokeWidth="1.2" />
      </g>
      <text x="322" y="66" fill="#fb7185" className={styles.retryLabel}>NO REWARD · TRY AGAIN</text>
      <text x="492" y="229" fill="#fbbf24" className={styles.rewardLabel}>REWARD +1</text>
    </svg>
  );
}

function OutlierGraphic() {
  return (
    <svg viewBox="0 0 620 300" className={styles.graphic} aria-hidden="true">
      <defs>
        <radialGradient id="learn-outlier-glow">
          <stop offset="0" stopColor="#c4b5fd" stopOpacity="0.44" />
          <stop offset="1" stopColor="#c4b5fd" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ChartGrid />
      <ellipse cx="292" cy="165" rx="154" ry="91" fill="#38bdf8" opacity="0.035" className={styles.detectionField} />
      <ellipse cx="292" cy="165" rx="154" ry="91" fill="none" stroke="#67e8f9" strokeWidth="1.3" strokeDasharray="5 7" opacity="0.7" className={styles.detectionField} />
      {OUTLIER_POINTS.map((point, index) => (
        <circle
          key={index}
          cx={point.x}
          cy={point.y}
          r={point.radius}
          fill="#67e8f9"
          opacity="0.72"
          className={styles.ordinaryPoint}
          style={{ animationDelay: `${point.delay}s` }}
        />
      ))}
      <circle cx="521" cy="66" r="44" fill="url(#learn-outlier-glow)" className={styles.outlierGlow} />
      <circle cx="521" cy="66" r="16" fill="none" stroke="#c4b5fd" strokeWidth="1.1" className={styles.outlierRing} />
      <circle cx="521" cy="66" r="5" fill="#ddd6fe" className={styles.outlierDot} />
      <path d="M508 79 L465 112 H404" fill="none" stroke="#c4b5fd" strokeWidth="1" opacity="0.8" />
      <text x="400" y="117" textAnchor="end" fill="#ddd6fe" fontSize="10" letterSpacing="1.8">UNUSUAL</text>
      <text x="564" y="27" textAnchor="end" fill="#8ca0b7" fontSize="9" letterSpacing="2">PATTERN / EXCEPTION</text>
    </svg>
  );
}

const GRAPHICS = [ClusteringGraphic, MazeGraphic, OutlierGraphic] as const;

export default function LearningCuriosityCarousel({ onChooseTopic }: Props) {
  const [slideIndex, setSlideIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const slide = SLIDES[slideIndex]!;
  const Graphic = GRAPHICS[slideIndex]!;

  useEffect(() => {
    if (hovered || focused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setSlideIndex(index => (index + 1) % SLIDES.length), 9_000);
    return () => window.clearInterval(timer);
  }, [slideIndex, hovered, focused]);

  return (
    <div
      className="mx-auto flex h-full w-full max-w-[42rem] flex-col px-1 pt-1"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      role="region"
      aria-roledescription="carousel"
      aria-label="Ideas to explore with Hugh"
    >
      <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
        <span className="h-px w-7 bg-amber-400/70" />
        A few questions worth following
      </div>
      <h2 className="mt-4 text-[clamp(1.5rem,1.8vw,2rem)] font-semibold leading-tight tracking-tight text-slate-100">
        Start with a little curiosity.
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">
        Watch an idea unfold, then make it your next topic.
      </p>

      <div className="mt-5" aria-live={hovered || focused ? "polite" : "off"} aria-atomic="true">
        <button
          type="button"
          onClick={() => onChooseTopic(slide.topic)}
          className="group block w-full overflow-hidden rounded-2xl border border-slate-600/65 bg-[#122037] text-left shadow-[0_24px_60px_rgba(0,0,0,0.14)] transition-colors hover:border-slate-400/65 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400"
          aria-label={`Explore ${slide.topic}: ${slide.title}`}
        >
          <div key={slide.topic} className={`${styles.stage} relative h-[13rem] overflow-hidden border-b border-slate-700/65 sm:h-[17.5rem]`}>
            <Graphic />
            <span className="absolute bottom-4 left-5 rounded-full border border-slate-500/45 bg-[#101b2c]/85 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-300">
              {slide.category}
            </span>
            <span className="absolute bottom-4 right-5 font-mono text-[10px] tracking-widest text-slate-400">
              {String(slideIndex + 1).padStart(2, "0")} / 03
            </span>
          </div>
          <div className="flex min-h-[7.25rem] items-center justify-between gap-5 px-6 py-4">
            <div>
              <h3 className="text-base font-semibold leading-snug tracking-tight text-slate-100">
                {slide.title}
              </h3>
              <p className="mt-1.5 max-w-[30rem] text-xs leading-relaxed text-slate-400">
                {slide.description}
              </p>
            </div>
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-600 text-slate-200 transition-colors group-hover:border-amber-300/70 group-hover:text-amber-200"
              aria-hidden="true"
            >
              <ArrowRight size={17} />
            </span>
          </div>
        </button>
      </div>

      <div className="mt-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2" aria-label="Choose an idea">
          {SLIDES.map((item, index) => (
            <button
              key={item.topic}
              type="button"
              onClick={() => setSlideIndex(index)}
              aria-label={`Show ${item.topic}`}
              aria-current={slideIndex === index ? "true" : undefined}
              className={`h-1.5 rounded-full transition-all focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400 ${slideIndex === index ? "w-8 bg-amber-300" : "w-4 bg-slate-600 hover:bg-slate-400"}`}
            />
          ))}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setSlideIndex(index => (index + SLIDES.length - 1) % SLIDES.length)}
            aria-label="Previous idea"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-600 text-slate-400 transition-colors hover:border-slate-400 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={() => setSlideIndex(index => (index + 1) % SLIDES.length)}
            aria-label="Next idea"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-600 text-slate-400 transition-colors hover:border-slate-400 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        Three starting points for now. You can also write any data or analytics topic of your own.
      </p>
    </div>
  );
}
