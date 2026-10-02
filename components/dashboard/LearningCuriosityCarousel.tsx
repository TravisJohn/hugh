"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
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
  {
    topic: "Gradient descent",
    category: "Machine learning · optimization",
    title: "How does a model find a better answer?",
    description: "Follow each careful step downhill as the model reduces its error.",
  },
  {
    topic: "Time series forecasting",
    category: "Data science · forecasting",
    title: "How far can a trend see?",
    description: "Past observations point forward, while the range of possible futures widens.",
  },
  {
    topic: "A/B testing",
    category: "Statistics · experiments",
    title: "Is B really better, or just lucky?",
    description: "Watch the evidence accumulate before deciding whether a difference is real.",
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

const EXPERIMENT_SAMPLES = Array.from({ length: 24 }, (_, index) => ({
  x: (index < 12 ? 113 : 369) + (index % 6) * 25,
  y: 99 + Math.floor((index % 12) / 6) * 20,
  delay: (index % 12) * 0.22,
  variant: index < 12 ? "a" : "b",
}));

function ChartGrid({ verticalLabel = "FEATURE 02" }: { verticalLabel?: string }) {
  return (
    <>
      <defs>
        <pattern id="learn-chart-grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <path d="M 28 0 L 0 0 0 28" fill="none" stroke="#36516b" strokeWidth="0.55" opacity="0.45" />
        </pattern>
      </defs>
      <rect width="620" height="300" fill="url(#learn-chart-grid)" opacity="0.55" />
      <path d="M52 35 V264 H574" fill="none" stroke="#66809b" strokeWidth="1" opacity="0.43" />
      <text x="56" y="27" fill="#7188a2" fontSize="9" letterSpacing="2">{verticalLabel}</text>
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

function DescentGraphic() {
  const steps = [
    [82, 100], [136, 142], [190, 184], [239, 211], [281, 226], [316, 230],
  ] as const;

  return (
    <svg viewBox="0 0 620 300" className={styles.graphic} aria-hidden="true">
      <defs>
        <linearGradient id="learn-loss-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fbbf24" stopOpacity="0.15" />
          <stop offset="1" stopColor="#fbbf24" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="learn-descent-glow">
          <stop offset="0" stopColor="#fbbf24" stopOpacity="0.7" />
          <stop offset="1" stopColor="#fbbf24" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d="M65 93 C106 107 148 151 195 187 S272 231 318 230 S415 186 560 60 L560 264 H65 Z" fill="url(#learn-loss-fill)" />
      <path d="M65 93 C106 107 148 151 195 187 S272 231 318 230 S415 186 560 60" fill="none" stroke="#fbbf24" strokeWidth="2" opacity="0.75" />
      <path d="M82 100 L136 142 L190 184 L239 211 L281 226 L316 230" fill="none" stroke="#fde68a" strokeWidth="1.5" strokeDasharray="4 6" className={styles.descentTrail} />
      {steps.map(([x, y], index) => (
        <circle key={index} cx={x} cy={y} r="4" fill="#fcd34d" className={styles.descentStep} style={{ animationDelay: `${index * 0.72}s` }} />
      ))}
      <g className={styles.descentWalker}>
        <circle r="29" fill="url(#learn-descent-glow)" />
        <circle r="8" fill="#fde68a" stroke="#fff7d6" strokeWidth="1.5" />
      </g>
      <text x="67" y="57" fill="#e7b861" fontSize="9" letterSpacing="2">HIGHER ERROR</text>
      <text x="315" y="257" textAnchor="middle" fill="#fcd34d" fontSize="9" letterSpacing="2">LOWER ERROR</text>
      <text x="555" y="27" textAnchor="end" fill="#8ca0b7" fontSize="9" letterSpacing="2">FOLLOW THE SLOPE</text>
    </svg>
  );
}

function ForecastGraphic() {
  return (
    <svg viewBox="0 0 620 300" className={styles.graphic} aria-hidden="true">
      <ChartGrid verticalLabel="VALUE" />
      <defs>
        <linearGradient id="learn-forecast-band" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#5eead4" stopOpacity="0.04" />
          <stop offset="1" stopColor="#5eead4" stopOpacity="0.22" />
        </linearGradient>
      </defs>
      <path d="M79 226 L115 208 L150 218 L184 168 L220 177 L257 145 L291 169 L327 113 L359 133 L388 116" fill="none" stroke="#5eead4" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" />
      {[ [79, 226], [115, 208], [150, 218], [184, 168], [220, 177], [257, 145], [291, 169], [327, 113], [359, 133], [388, 116] ].map(([x, y], index) => (
        <circle key={index} cx={x} cy={y} r="3" fill="#99f6e4" />
      ))}
      <path d="M388 116 C445 86 506 55 560 42 L560 215 C508 192 453 152 388 116 Z" fill="url(#learn-forecast-band)" className={styles.forecastBand} />
      <path d="M388 116 C445 86 506 55 560 42 M388 116 C453 152 508 192 560 215" fill="none" stroke="#5eead4" strokeWidth="1" strokeDasharray="4 6" opacity="0.48" className={styles.forecastBand} />
      <path d="M388 116 C449 111 510 125 560 132" fill="none" stroke="#fbbf24" strokeWidth="2.7" strokeDasharray="7 6" strokeLinecap="round" className={styles.forecastLine} />
      <path d="M388 52 V258" fill="none" stroke="#8ca0b7" strokeWidth="1" strokeDasharray="3 6" opacity="0.75" />
      <circle cx="388" cy="116" r="5" fill="#99f6e4" />
      <text x="337" y="63" textAnchor="end" fill="#8ca0b7" fontSize="9" letterSpacing="2">OBSERVED</text>
      <text x="436" y="63" fill="#fbbf24" fontSize="9" letterSpacing="2">POSSIBLE FUTURES</text>
    </svg>
  );
}

function ExperimentGraphic() {
  return (
    <svg viewBox="0 0 620 300" className={styles.graphic} aria-hidden="true">
      <text x="560" y="27" textAnchor="end" fill="#8ca0b7" fontSize="9" letterSpacing="2">MORE DATA → MORE CONFIDENCE</text>
      <rect x="72" y="48" width="220" height="204" rx="14" fill="#153044" stroke="#426076" strokeWidth="1" />
      <rect x="328" y="48" width="220" height="204" rx="14" fill="#2b283e" stroke="#645779" strokeWidth="1" />
      <text x="98" y="79" fill="#7dd3fc" fontSize="10" fontWeight="700" letterSpacing="2">A / CONTROL</text>
      <text x="354" y="79" fill="#c4b5fd" fontSize="10" fontWeight="700" letterSpacing="2">B / VARIANT</text>
      {EXPERIMENT_SAMPLES.map((sample, index) => (
        <circle key={index} cx={sample.x} cy={sample.y} r="3.5" fill={sample.variant === "a" ? "#7dd3fc" : "#c4b5fd"} className={styles.experimentSample} style={{ animationDelay: `${sample.delay}s` }} />
      ))}
      <path d="M110 226 H254 M366 226 H510" fill="none" stroke="#7890a8" strokeWidth="1" opacity="0.6" />
      <rect x="153" y="157" width="60" height="69" rx="5" fill="#38bdf8" opacity="0.78" className={styles.experimentBarA} />
      <rect x="409" y="132" width="60" height="94" rx="5" fill="#a78bfa" opacity="0.82" className={styles.experimentBarB} />
      <path d="M223 157 H397 M397 157 V132" fill="none" stroke="#fbbf24" strokeWidth="1.3" strokeDasharray="4 5" className={styles.experimentDifference} />
    </svg>
  );
}

const GRAPHICS = [ClusteringGraphic, MazeGraphic, OutlierGraphic, DescentGraphic, ForecastGraphic, ExperimentGraphic] as const;

export default function LearningCuriosityCarousel({ onChooseTopic }: Props) {
  const [slideIndex, setSlideIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const slide = SLIDES[slideIndex]!;
  const Graphic = GRAPHICS[slideIndex]!;
  const autoPlaying = !paused && !reducedMotion;

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => setReducedMotion(preference.matches);
    syncPreference();
    preference.addEventListener("change", syncPreference);
    return () => preference.removeEventListener("change", syncPreference);
  }, []);

  return (
    <div
      className="mx-auto flex h-full w-full max-w-[42rem] flex-col px-1 pt-1"
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

      <div className="mt-5" aria-live={autoPlaying ? "off" : "polite"} aria-atomic="true">
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
              {String(slideIndex + 1).padStart(2, "0")} / {String(SLIDES.length).padStart(2, "0")}
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
              className={`relative h-1.5 overflow-hidden rounded-full transition-all focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400 ${slideIndex === index ? "w-8 bg-slate-600" : "w-4 bg-slate-600 hover:bg-slate-400"}`}
            >
              {slideIndex === index && (
                <span
                  className={`absolute inset-0 origin-left bg-amber-300 ${styles.slideProgress} ${autoPlaying ? "" : styles.progressPaused}`}
                  onAnimationEnd={() => {
                    if (autoPlaying) setSlideIndex(current => (current + 1) % SLIDES.length);
                  }}
                />
              )}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPaused(value => !value)}
            aria-label={reducedMotion ? "Automatic slides disabled by reduced motion preference" : paused ? "Resume automatic slides" : "Pause automatic slides"}
            title={reducedMotion ? "Automatic slides disabled by reduced motion preference" : paused ? "Resume automatic slides" : "Pause automatic slides"}
            disabled={reducedMotion}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-600 text-slate-400 transition-colors hover:border-slate-400 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            {paused || reducedMotion ? <Play size={15} /> : <Pause size={15} />}
          </button>
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
        Six starting points to explore. You can also write any data or analytics topic of your own.
      </p>
    </div>
  );
}
