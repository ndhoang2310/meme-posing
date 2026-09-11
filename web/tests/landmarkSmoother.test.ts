import { describe, expect, it } from "vitest";
import { DetectionSmoother, SHOW_AFTER_MS } from "../src/vision/landmarkSmoother";
import type { PlayerDetection } from "../src/app/types";

function det(x: number, ts: number): PlayerDetection {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  landmarks[11] = { x, y: 0.5, z: 0 };
  return {
    landmarks,
    boundingBox: { x, y: 0.5, width: 0.2, height: 0.3 },
    detected: true,
    timestampMs: ts,
  };
}

describe("DetectionSmoother", () => {
  it("holds a brand-new presence in probation, then displays it", () => {
    const s = new DetectionSmoother();
    // First sighting: not shown yet (phantom guard).
    expect(s.update(det(0.2, 100), 1000)).toBeNull();
    // Same packet re-fed past the probation window: shown.
    const out = s.update(det(0.2, 100), 1000 + SHOW_AFTER_MS + 50);
    expect(out?.landmarks[11].x).toBeCloseTo(0.2, 6);
  });

  it("never displays a single phantom frame", () => {
    const s = new DetectionSmoother();
    s.update(det(0.9, 100), 1000); // phantom, shown as null
    // Gone before probation ends: screen stays empty the whole time.
    expect(s.update(null, 1016)).toBeNull();
    expect(s.update(null, 1200)).toBeNull();
  });

  it("snaps to new packets with no glide (zero motion lag)", () => {
    const s = new DetectionSmoother();
    s.update(det(0.0, 100), 1000);
    s.update(det(0.0, 100), 1300); // stable -> shown at 0.0
    // New packet displayed immediately at its raw value, not interpolated.
    expect(s.update(det(1.0, 200), 1400)?.landmarks[11].x).toBeCloseTo(1.0, 6);
    expect(s.update(det(1.0, 200), 1450)?.landmarks[11].x).toBeCloseTo(1.0, 6);
  });

  it("freezes inside grace on loss, then drops to null", () => {
    const s = new DetectionSmoother(350);
    s.update(det(0.4, 100), 1000);
    s.update(det(0.4, 100), 1300); // stable -> shown
    expect(s.update(null, 1400)?.landmarks[11].x).toBeCloseTo(0.4, 6);
    expect(s.update(null, 1800)).toBeNull();
  });

  it("presence level fades up with detection, down without", () => {
    const s = new DetectionSmoother();
    expect(s.getPresence()).toBe(0);
    s.update(det(0.2, 100), 1000); // first tick: dt=0, stays 0
    expect(s.getPresence()).toBe(0);
    // dt clamps at 100ms: rise step = 100/150, decay step = 100/700.
    s.update(det(0.2, 100), 1150);
    expect(s.getPresence()).toBeCloseTo(0.667, 2);
    s.update(null, 1300);
    expect(s.getPresence()).toBeCloseTo(0.571, 2);
    s.reset();
    expect(s.getPresence()).toBe(0);
  });

  it("re-acquire sticks to the frozen pose through probation, no snap", () => {
    const s = new DetectionSmoother(350);
    s.update(det(0.0, 100), 1000);
    s.update(det(0.0, 100), 1300); // shown at 0.0
    s.update(null, 1400); // frozen
    // New pose arrives: display holds the old one through probation.
    const out = s.update(det(1.0, 300), 1500);
    expect(out?.landmarks[11].x ?? -1).toBeLessThan(0.5);
  });
});
