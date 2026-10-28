// ── The Orb — Hugh's mascot, as geometry and poses ──────────────────────────
//
// Hugh is drawn as a sky-blue orb with one eye. It replaced the illustrated
// mascot (white hair, glasses, a bow tie) because an AI that observes how
// someone learns needs a face that can move, and a flat PNG cannot.
//
// Everything the Orb can look like is decided here, as plain data:
// components/brand/HughOrb.tsx only draws what `resolveOrb` returns, and the
// tab icon is generated from the same numbers by scripts/render-orb-icon.ts.
//
// Three rules the tests hold:
//
//   1. The eye never leaves the orb, and the pupil never leaves the eye — in
//      every mood, at both framings, at the far end of the watching sweep. At
//      22px a white eye touching the edge reads as a bite out of the orb.
//
//   2. The ring shows exactly when the Orb is watching, at both framings. The
//      ring is the "Hugh is observing you" signal, so a learner can always
//      tell at a glance whether they are being watched.
//
//   3. Nothing is drawn outside the frame it is drawn in.
//
// Units are viewBox units: a 120 × 120 box centred on (60, 60).

export const ORB_MOODS = ["idle", "watching", "thinking", "noticed", "pleased"] as const;
export type OrbMood = (typeof ORB_MOODS)[number];

/**
 * "roomy" leaves space around the orb for the ripple ring, the hop and the
 * thinking dots. "tight" crops to the orb itself, for small avatars.
 */
export type OrbFraming = "roomy" | "tight";

export interface Point {
  x: number;
  y: number;
}

export const ORB_VIEWBOX = 120;
export const ORB_CENTRE = 60;
export const ORB_BODY_RADIUS = 30;
export const ORB_IRIS_RADIUS = 13;
export const ORB_PUPIL_RADIUS = 6;

/** How far the whole eye moves from the orb's centre at full gaze. */
export const ORB_EYE_TRAVEL = 6;
/** How far the pupil moves inside the eye at full gaze, on top of the eye's own move. */
export const ORB_PUPIL_TRAVEL = 4;
/** The least gap kept between the eye and the orb's edge, and the pupil and the eye's edge. */
export const ORB_EDGE_MARGIN = 2;

/** Space around the orb in tight framing: room for the breath and a slim ring. */
const TIGHT_PAD = 4;

/** The ripple ring in roomy framing. It grows to 1.12× in HughOrb.module.css. */
const ROOMY_RING = { radius: 40, stroke: 2 } as const;

/** sky-400 (the app's --color-accent), slate-50 and slate-900 (--color-background). */
export const ORB_COLORS = {
  body: "#38BDF8",
  eye: "#F8FAFC",
  pupil: "#0F172A",
} as const;

/** "Pleased" swaps the eye for this closed, upturned arc. */
export const ORB_SMILE_PATH =
  `M${ORB_CENTRE - 12} ${ORB_CENTRE + 3} Q${ORB_CENTRE} ${ORB_CENTRE - 9} ${ORB_CENTRE + 12} ${ORB_CENTRE + 3}`;

/** Three dots rising off the top-right of the orb while it thinks. Roomy framing only. */
export const ORB_THINKING_DOTS: readonly (Point & { r: number })[] = [
  { x: 98, y: 24, r: 3 },
  { x: 105, y: 17, r: 2.2 },
  { x: 110, y: 11, r: 1.6 },
];

export type OrbMotion = "breathe" | "hop" | "still";

interface OrbPose {
  /** Which way the eye looks: a direction, each axis -1..1. */
  gaze: Point;
  /** Half-width of the side-to-side sweep, in viewBox units. 0 holds still. */
  sweep: number;
  /** 1 is resting size. */
  eyeScale: number;
  eyeShape: "open" | "smile";
  blinks: boolean;
  motion: OrbMotion;
  /** Whether the Orb is observing. Drawn as the ring. */
  watching: boolean;
  dots: boolean;
}

export const ORB_POSES: Record<OrbMood, OrbPose> = {
  // A slow breath and the odd blink, so a resting Orb reads as alive, not frozen.
  idle:     { gaze: { x: 0, y: 0 },      sweep: 0, eyeScale: 1,   eyeShape: "open",  blinks: true,  motion: "breathe", watching: false, dots: false },
  // Looking down at the work and following it across, with the ring on.
  watching: { gaze: { x: 0, y: 0.3 },    sweep: 3, eyeScale: 1,   eyeShape: "open",  blinks: true,  motion: "still",   watching: true,  dots: false },
  // Up and away, the way people look when they think.
  thinking: { gaze: { x: 0.7, y: -0.7 }, sweep: 0, eyeScale: 1,   eyeShape: "open",  blinks: false, motion: "still",   watching: false, dots: true  },
  // A small hop and a wider eye.
  noticed:  { gaze: { x: 0, y: 0 },      sweep: 0, eyeScale: 1.2, eyeShape: "open",  blinks: false, motion: "hop",     watching: false, dots: false },
  pleased:  { gaze: { x: 0, y: 0 },      sweep: 0, eyeScale: 1,   eyeShape: "smile", blinks: false, motion: "breathe", watching: false, dots: false },
};

/** A ring that ripples outward (roomy) or pulses in place just outside the orb (tight). */
export interface OrbRing {
  radius: number;
  stroke: number;
  motion: "ripple" | "pulse";
}

export interface OrbRender {
  viewBox: string;
  /** Half the frame's width: the furthest anything may sit from the centre along an axis. */
  frameHalf: number;
  /** The eye's centre, as an offset from the orb's centre. */
  eye: Point;
  /** The pupil's centre, as an offset from the eye's centre. */
  pupil: Point;
  sweep: number;
  eyeScale: number;
  eyeShape: "open" | "smile";
  blinks: boolean;
  motion: OrbMotion;
  ring: OrbRing | null;
  dots: boolean;
}

/**
 * Turns any value into a mood. Anything unknown becomes "idle", so a bad mood
 * from the observer shows a calm Orb rather than a broken one.
 */
export function parseOrbMood(value: unknown): OrbMood {
  return ORB_MOODS.find((mood) => mood === value) ?? "idle";
}

/**
 * Where the eye and pupil sit for a gaze. A gaze longer than 1 is clamped to
 * 1, so no caller can push the pupil out of the eye.
 */
export function orbEyePlacement(gaze: Point): { eye: Point; pupil: Point } {
  const length = Math.hypot(gaze.x, gaze.y);
  const scale = length > 1 ? 1 / length : 1;
  const x = gaze.x * scale;
  const y = gaze.y * scale;
  return {
    eye: { x: x * ORB_EYE_TRAVEL, y: y * ORB_EYE_TRAVEL },
    pupil: { x: x * ORB_PUPIL_TRAVEL, y: y * ORB_PUPIL_TRAVEL },
  };
}

/** Everything HughOrb draws for a mood at a framing. */
export function resolveOrb(mood: OrbMood, framing: OrbFraming = "roomy"): OrbRender {
  const pose = ORB_POSES[mood];
  const { eye, pupil } = orbEyePlacement(pose.gaze);
  const tight = framing === "tight";
  const frameHalf = tight ? ORB_BODY_RADIUS + TIGHT_PAD : ORB_VIEWBOX / 2;
  const origin = ORB_CENTRE - frameHalf;

  // In tight framing the ring sits midway between the orb's edge and the
  // frame's, and pulses in place: there is no room for it to ripple out.
  const ring: OrbRing | null = !pose.watching
    ? null
    : tight
      ? { radius: ORB_BODY_RADIUS + TIGHT_PAD / 2, stroke: TIGHT_PAD / 2, motion: "pulse" }
      : { ...ROOMY_RING, motion: "ripple" };

  return {
    viewBox: `${origin} ${origin} ${frameHalf * 2} ${frameHalf * 2}`,
    frameHalf,
    eye,
    pupil,
    sweep: pose.sweep,
    eyeScale: pose.eyeScale,
    eyeShape: pose.eyeShape,
    blinks: pose.blinks,
    // The hop rises out of a tight frame, so a small Orb holds still instead.
    motion: tight && pose.motion === "hop" ? "still" : pose.motion,
    ring,
    dots: pose.dots && !tight,
  };
}

/**
 * The tab icon: a still Orb, resting, tightly framed. Written to app/icon1.svg
 * by scripts/render-orb-icon.ts; a test fails while that file is out of date.
 */
export function orbIconSvg(): string {
  const orb = resolveOrb("idle", "tight");
  const eyeX = ORB_CENTRE + orb.eye.x;
  const eyeY = ORB_CENTRE + orb.eye.y;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${orb.viewBox}">`,
    `  <circle cx="${ORB_CENTRE}" cy="${ORB_CENTRE}" r="${ORB_BODY_RADIUS}" fill="${ORB_COLORS.body}"/>`,
    `  <circle cx="${eyeX}" cy="${eyeY}" r="${ORB_IRIS_RADIUS}" fill="${ORB_COLORS.eye}"/>`,
    `  <circle cx="${eyeX + orb.pupil.x}" cy="${eyeY + orb.pupil.y}" r="${ORB_PUPIL_RADIUS}" fill="${ORB_COLORS.pupil}"/>`,
    `</svg>`,
    "",
  ].join("\n");
}
