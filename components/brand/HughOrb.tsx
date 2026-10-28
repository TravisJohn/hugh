// ── HughOrb — Hugh's mascot, drawn and animated ─────────────────────────────
//
// Draws whatever lib/brand/orb.ts resolves for a mood; it decides nothing of
// its own. Motion is CSS only (HughOrb.module.css), so the Orb needs no client
// JavaScript and renders the same in server and client components.

import type { CSSProperties } from "react";
import {
  ORB_BODY_RADIUS,
  ORB_CENTRE,
  ORB_COLORS,
  ORB_IRIS_RADIUS,
  ORB_PUPIL_RADIUS,
  ORB_SMILE_PATH,
  ORB_THINKING_DOTS,
  resolveOrb,
  type OrbFraming,
  type OrbMood,
  type OrbMotion,
} from "@/lib/brand/orb";
import styles from "./HughOrb.module.css";

const MOTION_CLASS: Record<OrbMotion, string | undefined> = {
  breathe: styles.breathe,
  hop: styles.hop,
  still: undefined,
};

interface Props {
  /** Width and height in px. A className can still resize it. */
  size: number;
  mood?: OrbMood;
  /** "tight" crops to the orb itself, for small avatars. */
  framing?: OrbFraming;
  /** The accessible name. Leave it out where nearby text already names Hugh. */
  label?: string;
  className?: string;
}

/** Joins class names, skipping the empty ones. */
function cx(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export default function HughOrb({ size, mood = "idle", framing = "roomy", label, className }: Props) {
  const orb = resolveOrb(mood, framing);
  const c = ORB_CENTRE;

  return (
    <svg
      viewBox={orb.viewBox}
      width={size}
      height={size}
      className={className}
      data-mood={mood}
      style={{ "--orb-centre": `${c}px` } as CSSProperties}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {orb.ring && (
        <circle
          className={orb.ring.motion === "ripple" ? styles.ripple : styles.pulse}
          cx={c}
          cy={c}
          r={orb.ring.radius}
          fill="none"
          stroke={ORB_COLORS.body}
          strokeWidth={orb.ring.stroke}
        />
      )}

      <g className={cx(styles.body, MOTION_CLASS[orb.motion])}>
        <circle cx={c} cy={c} r={ORB_BODY_RADIUS} fill={ORB_COLORS.body} />

        <g
          className={styles.gaze}
          style={{ transform: `translate(${orb.eye.x}px, ${orb.eye.y}px) scale(${orb.eyeScale})` }}
        >
          <g
            className={orb.sweep > 0 ? styles.sweep : undefined}
            style={{ "--orb-sweep": `${orb.sweep}px` } as CSSProperties}
          >
            <g className={cx(styles.eye, orb.eyeShape !== "open" && styles.hidden)}>
              <g className={orb.blinks ? styles.blink : undefined}>
                <circle cx={c} cy={c} r={ORB_IRIS_RADIUS} fill={ORB_COLORS.eye} />
                <circle
                  className={styles.pupil}
                  cx={c}
                  cy={c}
                  r={ORB_PUPIL_RADIUS}
                  fill={ORB_COLORS.pupil}
                  style={{ transform: `translate(${orb.pupil.x}px, ${orb.pupil.y}px)` }}
                />
              </g>
            </g>
          </g>
        </g>

        <path
          className={cx(styles.eye, orb.eyeShape !== "smile" && styles.hidden)}
          d={ORB_SMILE_PATH}
          fill="none"
          stroke={ORB_COLORS.eye}
          strokeWidth={5}
          strokeLinecap="round"
        />
      </g>

      {orb.dots && (
        <g className={styles.dots} fill={ORB_COLORS.body}>
          {ORB_THINKING_DOTS.map((dot) => (
            <circle key={`${dot.x}-${dot.y}`} cx={dot.x} cy={dot.y} r={dot.r} />
          ))}
        </g>
      )}
    </svg>
  );
}
