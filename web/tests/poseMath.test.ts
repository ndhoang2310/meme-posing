import { describe, expect, it } from "vitest";
import {
  calculateAngle,
  isPoseMatch,
  jointAngles,
  poseMatchSimilarity,
} from "../src/game/poseMath";
import type { Landmark } from "../src/app/types";

function lm(x: number, y: number): Landmark {
  return { x, y, z: 0 };
}

function blank(tweak?: Record<number, Landmark>): Landmark[] {
  const arr: Landmark[] = Array.from({ length: 33 }, () => lm(0.5, 0.5));
  if (tweak) for (const [k, v] of Object.entries(tweak)) arr[Number(k)] = v as Landmark;
  return arr;
}

describe("calculateAngle", () => {
  it("returns 90 for a right angle", () => {
    expect(calculateAngle(lm(0, 0), lm(0, 1), lm(1, 1))).toBeCloseTo(90, 6);
  });
  it("returns 180 for a straight line", () => {
    expect(calculateAngle(lm(0, 0), lm(1, 0), lm(2, 0))).toBeCloseTo(180, 6);
  });
  it("returns ~0 for a folded-back angle", () => {
    expect(calculateAngle(lm(1, 0), lm(0, 0), lm(1, 0.0001))).toBeCloseTo(0, 1);
  });
  it("stays within 0..180", () => {
    const a = calculateAngle(lm(0.2, 0.7), lm(0.5, 0.5), lm(0.9, 0.1));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(180);
  });
});

describe("jointAngles", () => {
  it("extracts 4 upper-body angles from correct landmark indices", () => {
    // Straight arms down: elbows ~180, shoulders wide.
    const lms = blank({
      11: lm(0.4, 0.3), 13: lm(0.4, 0.5), 15: lm(0.4, 0.7),
      12: lm(0.6, 0.3), 14: lm(0.6, 0.5), 16: lm(0.6, 0.7),
      23: lm(0.4, 0.8), 24: lm(0.6, 0.8),
    });
    const angles = jointAngles(lms);
    expect(angles).not.toBeNull();
    expect(angles).toHaveLength(4);
    expect(angles![0]).toBeCloseTo(180, 0);
    expect(angles![1]).toBeCloseTo(180, 0);
  });
  it("returns null for missing/invalid landmarks without throwing", () => {
    expect(jointAngles(null)).toBeNull();
    expect(jointAngles([])).toBeNull();
    expect(jointAngles(blank())).not.toBeNull(); // degenerate but finite
    const bad = blank({ 11: { x: NaN, y: 0 } as Landmark });
    expect(jointAngles(bad)).toBeNull();
  });
});

describe("poseMatchSimilarity", () => {
  it("is 1 for an identical vector", () => {
    expect(poseMatchSimilarity([90, 90, 90, 90], [90, 90, 90, 90])).toBe(1);
  });
  it("degrades linearly: 30deg error on one joint of four => 0.875", () => {
    expect(poseMatchSimilarity([120, 90, 90, 90], [90, 90, 90, 90])).toBeCloseTo(0.875, 6);
  });
  it("is 0 when a joint is 60+ degrees off on all joints", () => {
    expect(poseMatchSimilarity([0, 0, 0, 0], [90, 90, 90, 90])).toBe(0);
  });
  it("returns 0 for mismatched/empty vectors without crashing", () => {
    expect(poseMatchSimilarity([], [1, 2])).toBe(0);
    expect(poseMatchSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(poseMatchSimilarity(null, [1, 2, 3, 4])).toBe(0);
    expect(poseMatchSimilarity([1, NaN, 3, 4], [1, 2, 3, 4])).toBe(0);
  });
  it("handles wrap-around (359 vs 1 => tiny error)", () => {
    expect(poseMatchSimilarity([359, 90, 90, 90], [1, 90, 90, 90])).toBeCloseTo(
      (1 - 2 / 60 + 3) / 4, 6,
    );
  });
});

describe("isPoseMatch", () => {
  it("matches at the 0.8 production threshold", () => {
    const { match, similarity } = isPoseMatch([90, 90, 90, 90], [90, 90, 90, 90]);
    expect(match).toBe(true);
    expect(similarity).toBe(1);
  });
});
