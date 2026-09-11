import { describe, expect, it } from "vitest";
import {
  IDLE_AFTER_NULLS,
  SPARSE_EVERY,
  SPARSE_PHASE_LEFT,
  SPARSE_PHASE_RIGHT,
  shouldRunHalf,
} from "../src/vision/detectionScheduler";

describe("shouldRunHalf", () => {
  it("runs at full rate while recently detected", () => {
    for (let seq = 0; seq < 20; seq++) {
      expect(shouldRunHalf(0, seq, SPARSE_PHASE_LEFT)).toBe(true);
      expect(shouldRunHalf(IDLE_AFTER_NULLS, seq, SPARSE_PHASE_RIGHT)).toBe(true);
    }
  });

  it("goes sparse after sustained nulls, on staggered phases", () => {
    const idle = IDLE_AFTER_NULLS + 1;
    const leftRuns: number[] = [];
    const rightRuns: number[] = [];
    for (let seq = 1; seq <= SPARSE_EVERY * 2; seq++) {
      if (shouldRunHalf(idle, seq, SPARSE_PHASE_LEFT)) leftRuns.push(seq);
      if (shouldRunHalf(idle, seq, SPARSE_PHASE_RIGHT)) rightRuns.push(seq);
    }
    // Each side runs 1-in-4, never on the same packet.
    expect(leftRuns).toHaveLength(2);
    expect(rightRuns).toHaveLength(2);
    expect(leftRuns.some((s) => rightRuns.includes(s))).toBe(false);
  });
});
