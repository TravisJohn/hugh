import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  ORB_BODY_RADIUS,
  ORB_CENTRE,
  ORB_EDGE_MARGIN,
  ORB_IRIS_RADIUS,
  ORB_MOODS,
  ORB_PUPIL_RADIUS,
  ORB_PUPIL_TRAVEL,
  ORB_THINKING_DOTS,
  orbEyePlacement,
  orbIconSvg,
  parseOrbMood,
  resolveOrb,
  type OrbFraming,
} from "./orb";

const FRAMINGS: OrbFraming[] = ["roomy", "tight"];

/** Every mood at every framing, labelled for the test name. */
const EVERY_ORB = ORB_MOODS.flatMap((mood) =>
  FRAMINGS.map((framing) => ({ mood, framing, orb: resolveOrb(mood, framing) })),
);

describe("parseOrbMood", () => {
  it("keeps every known mood", () => {
    for (const mood of ORB_MOODS) expect(parseOrbMood(mood)).toBe(mood);
  });

  it("falls back to idle for anything else, so a bad mood shows a calm Orb rather than a broken one", () => {
    for (const value of [undefined, null, "", "IDLE", "angry", 3, {}]) {
      expect(parseOrbMood(value)).toBe("idle");
    }
  });
});

describe("the eye stays inside the orb", () => {
  it.each(EVERY_ORB)("$mood, $framing: even at the far end of the sweep", ({ orb }) => {
    // The sweep moves the eye side to side, so its worst case adds to x.
    const reach = Math.hypot(Math.abs(orb.eye.x) + orb.sweep, orb.eye.y);
    const eyeEdge = reach + ORB_IRIS_RADIUS * orb.eyeScale;
    expect(eyeEdge).toBeLessThanOrEqual(ORB_BODY_RADIUS - ORB_EDGE_MARGIN);
  });

  it.each(EVERY_ORB)("$mood, $framing: the pupil stays inside the eye", ({ orb }) => {
    // Pupil and eye scale together, so the check holds in the eye's own units.
    const pupilEdge = Math.hypot(orb.pupil.x, orb.pupil.y) + ORB_PUPIL_RADIUS;
    expect(pupilEdge).toBeLessThanOrEqual(ORB_IRIS_RADIUS - ORB_EDGE_MARGIN);
  });

  it("clamps an over-long gaze, so no caller can push the pupil out of the eye", () => {
    const { pupil } = orbEyePlacement({ x: 5, y: -5 });
    expect(Math.hypot(pupil.x, pupil.y)).toBeCloseTo(ORB_PUPIL_TRAVEL, 6);
    expect(Math.hypot(pupil.x, pupil.y) + ORB_PUPIL_RADIUS).toBeLessThanOrEqual(ORB_IRIS_RADIUS - ORB_EDGE_MARGIN);
  });

  it("leaves a short gaze unclamped", () => {
    const { eye, pupil } = orbEyePlacement({ x: 0.5, y: 0 });
    expect(pupil).toEqual({ x: ORB_PUPIL_TRAVEL / 2, y: 0 });
    expect(eye.y).toBe(0);
  });
});

describe("the ring is the watching signal", () => {
  it.each(FRAMINGS)("%s: shows the ring exactly when the Orb is watching, so a learner can always tell", (framing) => {
    const ringed = ORB_MOODS.filter((mood) => resolveOrb(mood, framing).ring !== null);
    expect(ringed).toEqual(["watching"]);
  });

  it("ripples outward when there is room, and pulses in place at avatar size", () => {
    expect(resolveOrb("watching", "roomy").ring?.motion).toBe("ripple");
    expect(resolveOrb("watching", "tight").ring?.motion).toBe("pulse");
  });

  it.each(FRAMINGS)("%s: the ring clears the orb's edge and stays inside the frame", (framing) => {
    const orb = resolveOrb("watching", framing);
    const ring = orb.ring!;
    expect(ring.radius - ring.stroke / 2).toBeGreaterThan(ORB_BODY_RADIUS);
    expect(ring.radius + ring.stroke / 2).toBeLessThanOrEqual(orb.frameHalf);
  });
});

describe("framing", () => {
  it("tight framing crops to the orb, so a 22px avatar is mostly orb", () => {
    const orb = resolveOrb("idle", "tight");
    expect(orb.viewBox).toBe(`${ORB_CENTRE - orb.frameHalf} ${ORB_CENTRE - orb.frameHalf} ${orb.frameHalf * 2} ${orb.frameHalf * 2}`);
    expect(ORB_BODY_RADIUS / orb.frameHalf).toBeGreaterThan(0.85);
  });

  it("a small Orb holds still instead of hopping out of its frame", () => {
    expect(resolveOrb("noticed", "roomy").motion).toBe("hop");
    expect(resolveOrb("noticed", "tight").motion).toBe("still");
  });

  it("drops the thinking dots at avatar size, where they would sit outside the frame", () => {
    expect(resolveOrb("thinking", "roomy").dots).toBe(true);
    expect(resolveOrb("thinking", "tight").dots).toBe(false);
  });

  it("puts the thinking dots off the orb and inside the roomy frame", () => {
    const { frameHalf } = resolveOrb("thinking", "roomy");
    for (const dot of ORB_THINKING_DOTS) {
      expect(Math.hypot(dot.x - ORB_CENTRE, dot.y - ORB_CENTRE) - dot.r).toBeGreaterThan(ORB_BODY_RADIUS);
      expect(Math.abs(dot.x - ORB_CENTRE) + dot.r).toBeLessThanOrEqual(frameHalf);
      expect(Math.abs(dot.y - ORB_CENTRE) + dot.r).toBeLessThanOrEqual(frameHalf);
    }
  });
});

describe("the tab icon", () => {
  it("app/icon1.svg matches the Orb's geometry (run `npm run brand:icon` after changing it)", () => {
    const path = fileURLToPath(new URL("../../app/icon1.svg", import.meta.url));
    // Normalise line endings: a Windows checkout may hand the file back with CRLF.
    const committed = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(orbIconSvg());
  });
});
