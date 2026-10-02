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
  {
    topic: "Neural networks",
    category: "Machine learning · neural networks",
    title: "How can layers recognize a pattern?",
    description: "Signals combine through a network until a useful pattern reaches the output.",
  },
  {
    topic: "Bayesian inference",
    category: "Statistics · probability",
    title: "How should evidence change a belief?",
    description: "A starting belief shifts as new evidence arrives, while uncertainty remains visible.",
  },
  {
    topic: "Decision trees",
    category: "Machine learning · decisions",
    title: "Which question should a model ask first?",
    description: "Each answer splits the possibilities, guiding the model toward a decision.",
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

const NETWORK_LAYERS = [
  [{ x: 92, y: 83 }, { x: 92, y: 150 }, { x: 92, y: 217 }],
  [{ x: 235, y: 61 }, { x: 235, y: 120 }, { x: 235, y: 180 }, { x: 235, y: 239 }],
  [{ x: 390, y: 83 }, { x: 390, y: 150 }, { x: 390, y: 217 }],
  [{ x: 528, y: 150 }],
] as const;

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

function NetworkGraphic() {
  return (
    <svg viewBox="0 0 620 300" className={styles.graphic} aria-hidden="true">
      <defs>
        <radialGradient id="learn-network-output">
          <stop offset="0" stopColor="#5eead4" stopOpacity="0.62" />
          <stop offset="1" stopColor="#5eead4" stopOpacity="0" />
        </radialGradient>
      </defs>
      <text x="92" y="27" textAnchor="middle" fill="#8ca0b7" fontSize="9" letterSpacing="2">INPUTS</text>
      <text x="314" y="27" textAnchor="middle" fill="#8ca0b7" fontSize="9" letterSpacing="2">LAYERS</text>
      <text x="528" y="27" textAnchor="middle" fill="#8ca0b7" fontSize="9" letterSpacing="2">OUTPUT</text>
      {NETWORK_LAYERS.slice(0, -1).flatMap((layer, layerIndex) =>
        layer.flatMap((from, fromIndex) =>
          NETWORK_LAYERS[layerIndex + 1]!.map((to, toIndex) => (
            <line key={`${layerIndex}-${fromIndex}-${toIndex}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#477089" strokeWidth="1" opacity="0.27" />
          )),
        ),
      )}
      <path d="M92 83 L235 120" fill="none" stroke="#5eead4" strokeWidth="4" className={styles.networkSignal} />
      <path d="M235 120 L390 150" fill="none" stroke="#5eead4" strokeWidth="4" className={styles.networkSignal} style={{ animationDelay: "1.3s" }} />
      <path d="M390 150 L528 150" fill="none" stroke="#5eead4" strokeWidth="4" className={styles.networkSignal} style={{ animationDelay: "2.6s" }} />
      <circle cx="92" cy="83" r="27" fill="url(#learn-network-output)" className={styles.networkNodeGlow} />
      <circle cx="235" cy="120" r="27" fill="url(#learn-network-output)" className={styles.networkNodeGlow} style={{ animationDelay: "1.3s" }} />
      <circle cx="390" cy="150" r="27" fill="url(#learn-network-output)" className={styles.networkNodeGlow} style={{ animationDelay: "2.6s" }} />
      <circle cx="528" cy="150" r="46" fill="url(#learn-network-output)" className={styles.networkOutput} />
      {NETWORK_LAYERS.flatMap((layer, layerIndex) =>
        layer.map((node, nodeIndex) => (
          <g key={`${layerIndex}-${nodeIndex}`}>
            <circle cx={node.x} cy={node.y} r="12" fill="#18364a" stroke="#6f9bb0" strokeWidth="1.1" />
            <circle cx={node.x} cy={node.y} r="4" fill={layerIndex === 3 ? "#5eead4" : "#9bd1e0"} opacity="0.8" />
          </g>
        )),
      )}
      <text x="528" y="199" textAnchor="middle" fill="#5eead4" fontSize="9" letterSpacing="2" className={styles.networkAnswer}>PATTERN FOUND</text>
    </svg>
  );
}

function BayesianGraphic() {
  return (
    <svg viewBox="0 0 620 300" className={styles.graphic} aria-hidden="true">
      <defs>
        <linearGradient id="learn-prior-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a78bfa" stopOpacity="0.27" />
          <stop offset="1" stopColor="#a78bfa" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id="learn-posterior-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5eead4" stopOpacity="0.3" />
          <stop offset="1" stopColor="#5eead4" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d="M66 238 H558" fill="none" stroke="#607a91" strokeWidth="1" opacity="0.65" />
      <path d="M76 238 C131 238 133 204 166 153 C188 117 211 99 235 105 C272 115 299 183 348 221 C366 234 387 238 405 238 Z" fill="url(#learn-prior-fill)" className={styles.priorCurve} />
      <path d="M76 238 C131 238 133 204 166 153 C188 117 211 99 235 105 C272 115 299 183 348 221 C366 234 387 238 405 238" fill="none" stroke="#a78bfa" strokeWidth="2.5" className={styles.priorCurve} />
      <path d="M253 238 C302 238 322 207 350 145 C371 98 389 75 410 82 C441 92 454 151 474 198 C491 228 516 238 548 238 Z" fill="url(#learn-posterior-fill)" className={styles.posteriorFill} />
      <path d="M253 238 C302 238 322 207 350 145 C371 98 389 75 410 82 C441 92 454 151 474 198 C491 228 516 238 548 238" fill="none" stroke="#5eead4" strokeWidth="2.8" className={styles.posteriorCurve} />
      <path d="M392 59 V236" fill="none" stroke="#fbbf24" strokeWidth="1.2" strokeDasharray="4 6" className={styles.evidenceLine} />
      <circle cx="392" cy="59" r="5" fill="#fbbf24" className={styles.evidenceDot} />
      <text x="150" y="91" fill="#c4b5fd" fontSize="9" letterSpacing="2">BEFORE</text>
      <text x="393" y="44" textAnchor="middle" fill="#fbbf24" fontSize="9" letterSpacing="2">EVIDENCE</text>
      <text x="488" y="102" fill="#99f6e4" fontSize="9" letterSpacing="2" className={styles.updatedLabel}>AFTER</text>
    </svg>
  );
}

function TreeGraphic() {
  return (
    <svg viewBox="0 0 620 300" className={styles.graphic} aria-hidden="true">
      <text x="557" y="27" textAnchor="end" fill="#8ca0b7" fontSize="9" letterSpacing="2">FOLLOW ONE PATH</text>
      <path d="M310 90 Q310 113 180 132 M310 90 Q310 113 440 132 M180 178 Q180 200 97 219 M180 178 Q180 200 233 219 M440 178 Q440 200 387 219 M440 178 Q440 200 523 219" fill="none" stroke="#54758c" strokeWidth="1.3" opacity="0.58" />
      <path d="M310 90 Q310 113 180 132 M180 178 Q180 200 233 219" fill="none" stroke="#67e8f9" strokeWidth="3" strokeLinecap="round" className={styles.treeRouteA} />
      <path d="M310 90 Q310 113 440 132 M440 178 Q440 200 523 219" fill="none" stroke="#fbbf24" strokeWidth="3" strokeLinecap="round" className={styles.treeRouteB} />
      <rect x="251" y="45" width="118" height="45" rx="11" fill="#203b50" stroke="#86a9bd" strokeWidth="1.2" />
      <text x="310" y="72" textAnchor="middle" fill="#e0f2fe" fontSize="11" fontWeight="700" letterSpacing="1">SIZE &gt; 5?</text>
      <rect x="120" y="132" width="120" height="46" rx="11" fill="#17394a" stroke="#5795a8" strokeWidth="1.2" />
      <rect x="380" y="132" width="120" height="46" rx="11" fill="#3b3440" stroke="#9c7d78" strokeWidth="1.2" />
      <text x="180" y="160" textAnchor="middle" fill="#a5f3fc" fontSize="10" fontWeight="700" letterSpacing="1">COLOR?</text>
      <text x="440" y="160" textAnchor="middle" fill="#fde68a" fontSize="10" fontWeight="700" letterSpacing="1">SHAPE?</text>
      {[97, 233, 387, 523].map((x, index) => (
        <g key={x}>
          <circle cx={x} cy="235" r="16" fill={index < 2 ? "#123b4d" : "#3a3447"} stroke={index < 2 ? "#67e8f9" : "#fbbf24"} strokeWidth="1.2" />
          <text x={x} y="239" textAnchor="middle" fill="#e2e8f0" fontSize="11" fontWeight="700">{String.fromCharCode(65 + index)}</text>
        </g>
      ))}
      <circle cx="233" cy="235" r="24" fill="none" stroke="#67e8f9" strokeWidth="1" className={styles.treeLeafA} />
      <circle cx="523" cy="235" r="24" fill="none" stroke="#fbbf24" strokeWidth="1" className={styles.treeLeafB} />
    </svg>
  );
}

const GRAPHICS = [ClusteringGraphic, MazeGraphic, OutlierGraphic, DescentGraphic, ForecastGraphic, ExperimentGraphic, NetworkGraphic, BayesianGraphic, TreeGraphic] as const;

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

      <div className="mt-5 flex items-center justify-between gap-3 sm:gap-4">
        <div className="flex items-center gap-1 sm:gap-2" aria-label="Choose an idea">
          {SLIDES.map((item, index) => (
            <button
              key={item.topic}
              type="button"
              onClick={() => setSlideIndex(index)}
              aria-label={`Show ${item.topic}`}
              aria-current={slideIndex === index ? "true" : undefined}
              className={`relative h-1.5 overflow-hidden rounded-full transition-all focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400 ${slideIndex === index ? "w-6 bg-slate-600 sm:w-8" : "w-2 bg-slate-600 hover:bg-slate-400 sm:w-4"}`}
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
            className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-600 text-slate-400 transition-colors hover:border-slate-400 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 sm:h-9 sm:w-9"
          >
            {paused || reducedMotion ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button
            type="button"
            onClick={() => setSlideIndex(index => (index + SLIDES.length - 1) % SLIDES.length)}
            aria-label="Previous idea"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-600 text-slate-400 transition-colors hover:border-slate-400 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 sm:h-9 sm:w-9"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={() => setSlideIndex(index => (index + 1) % SLIDES.length)}
            aria-label="Next idea"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-600 text-slate-400 transition-colors hover:border-slate-400 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 sm:h-9 sm:w-9"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        {SLIDES.length} starting points to explore. You can also write any data or analytics topic of your own.
      </p>
    </div>
  );
}
