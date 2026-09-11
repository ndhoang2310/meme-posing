import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../src/app/game-config";
import type { Landmark, PoseDefinition, VisionPacket } from "../src/app/types";
import { GameEngine } from "../src/game/GameEngine";
import { jointAngles } from "../src/game/poseMath";

function lm(x: number, y: number): Landmark {
  return { x, y, z: 0 };
}

/** Landmark set with straight arms (elbows ~180). */
function matchLandmarks(): Landmark[] {
  const arr: Landmark[] = Array.from({ length: 33 }, () => lm(0.5, 0.5));
  arr[11] = lm(0.4, 0.3); arr[13] = lm(0.4, 0.5); arr[15] = lm(0.4, 0.7);
  arr[12] = lm(0.6, 0.3); arr[14] = lm(0.6, 0.5); arr[16] = lm(0.6, 0.7);
  arr[23] = lm(0.4, 0.8); arr[24] = lm(0.6, 0.8);
  return arr;
}

/** Degenerate landmarks -> angles [0,0,0,0], far from any realistic target. */
function missLandmarks(): Landmark[] {
  return Array.from({ length: 33 }, () => lm(0.5, 0.5));
}

function detection(lms: Landmark[]) {
  return {
    landmarks: lms,
    boundingBox: { x: 0, y: 0, width: 1, height: 1 },
    detected: true as const,
    timestampMs: 0,
  };
}

function packet(kind: "both-match" | "both-miss" | "left-only" | "left-miss-only" | "none"): VisionPacket {
  const m = detection(matchLandmarks());
  const miss = detection(missLandmarks());
  switch (kind) {
    case "both-match": return { timestampMs: 0, left: m, right: m };
    case "both-miss": return { timestampMs: 0, left: miss, right: miss };
    case "left-only": return { timestampMs: 0, left: m, right: null };
    case "left-miss-only": return { timestampMs: 0, left: miss, right: null };
    case "none": return { timestampMs: 0, left: null, right: null };
  }
}

function catalogOf(n: number, target: [number, number, number, number]): PoseDefinition[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `pose_${i}`,
    imageUrl: `/poses/p${i}.jpg`,
    targetVector: target,
  }));
}

const MATCH_TARGET = jointAngles(matchLandmarks())!;

/** Step the engine in 100ms increments for totalMs. Returns last snapshot. */
function step(engine: GameEngine, totalMs: number, kind: "both-match" | "both-miss" | "left-only" | "left-miss-only" | "none", startAt: { t: number }) {
  let snap = engine.snapshot();
  const steps = Math.ceil(totalMs / 100);
  for (let i = 0; i < steps; i++) {
    startAt.t += 100;
    snap = engine.update(packet(kind, ), startAt.t);
  }
  return snap;
}

describe("GameEngine", () => {
  it("IDLE waits for 2s of stable dual detection", () => {
    const e = new GameEngine();
    e.setCatalog(catalogOf(10, MATCH_TARGET));
    const clock = { t: 1000 };
    e.update(packet("none"), clock.t);
    let snap = step(e, 1900, "both-match", clock);
    expect(snap.state).toBe("IDLE");
    snap = step(e, 300, "both-match", clock);
    expect(snap.state).toBe("COUNTDOWN");
  });

  it("IDLE resets stability when a player is lost", () => {
    const e = new GameEngine();
    e.setCatalog(catalogOf(10, MATCH_TARGET));
    const clock = { t: 1000 };
    e.update(packet("none"), clock.t);
    step(e, 1500, "both-match", clock);
    step(e, 500, "left-only", clock); // lose right -> reset
    step(e, 1500, "both-match", clock);
    expect(e.snapshot().state).toBe("IDLE");
    const snap = step(e, 600, "both-match", clock);
    expect(snap.state).toBe("COUNTDOWN");
  });

  it("COUNTDOWN lasts 3s then starts PLAYING with round 1", () => {
    const e = new GameEngine();
    e.setCatalog(catalogOf(10, MATCH_TARGET));
    const clock = { t: 1000 };
    e.update(packet("both-match"), clock.t);
    step(e, 2000, "both-match", clock);
    expect(e.snapshot().state).toBe("COUNTDOWN");
    const snap = step(e, 3100, "both-match", clock);
    expect(snap.state).toBe("PLAYING");
    expect(snap.roundNumber).toBe(1);
    expect(snap.currentPose).not.toBeNull();
  });

  it("scores once per pose after a 400ms hold", () => {
    const e = new GameEngine();
    e.setCatalog(catalogOf(10, MATCH_TARGET));
    const clock = { t: 1000 };
    e.update(packet("both-match"), clock.t);
    step(e, 2000, "both-match", clock);
    step(e, 3000, "both-match", clock); // countdown done -> PLAYING
    // Both hold; left wins the tie-break (equal hold => left).
    const before = e.snapshot();
    expect(before.state).toBe("PLAYING");
    const snap = step(e, 500, "both-match", clock);
    expect(snap.score.left + snap.score.right).toBe(1);
    expect(snap.roundNumber).toBe(2);
  });

  it("resets the hold timer when similarity drops", () => {
    const e = new GameEngine();
    e.setCatalog(catalogOf(10, MATCH_TARGET));
    const clock = { t: 1000 };
    e.update(packet("both-match"), clock.t);
    step(e, 2000, "both-match", clock);
    step(e, 3000, "both-match", clock);
    step(e, 300, "both-match", clock); // partial hold 300ms
    expect(e.snapshot().holdMs.left).toBeGreaterThan(0);
    step(e, 200, "both-miss", clock); // drop below threshold
    expect(e.snapshot().holdMs.left).toBe(0);
    expect(e.snapshot().score.left).toBe(0);
  });

  it("pose timeout advances the round without scoring", () => {
    const e = new GameEngine();
    e.setCatalog(catalogOf(10, MATCH_TARGET));
    const clock = { t: 1000 };
    e.update(packet("both-miss"), clock.t);
    // IDLE needs detections; drive idle with matches then miss during play.
    step(e, 2000, "both-match", clock);
    step(e, 3000, "both-match", clock);
    const snap = step(e, GAME_CONFIG.poseTimeoutMs + 500, "both-miss", clock);
    expect(snap.roundNumber).toBe(2);
    expect(snap.score.left).toBe(0);
    expect(snap.score.right).toBe(0);
  });

  it("pauses after 1.5s of lost tracking and resumes with countdown keeping score", () => {
    const e = new GameEngine();
    e.setCatalog(catalogOf(10, MATCH_TARGET));
    const clock = { t: 1000 };
    e.update(packet("both-match"), clock.t);
    step(e, 2000, "both-match", clock);
    step(e, 3000, "both-match", clock);
    step(e, 500, "both-match", clock); // someone scores round 1
    const scoreLeft = e.snapshot().score.left;
    expect(scoreLeft).toBe(1);
    const snap = step(e, 2000, "left-miss-only", clock);
    expect(snap.state).toBe("PAUSED");
    const resumed = step(e, 500, "both-match", clock);
    expect(resumed.state).toBe("COUNTDOWN");
    expect(resumed.score.left).toBe(scoreLeft);
    expect(resumed.roundNumber).toBe(2); // round progress kept
  });

  it("PAUSED falls back to IDLE after 3s without players", () => {
    const e = new GameEngine();
    e.setCatalog(catalogOf(10, MATCH_TARGET));
    const clock = { t: 1000 };
    e.update(packet("both-match"), clock.t);
    step(e, 2000, "both-match", clock);
    step(e, 3000, "both-match", clock);
    step(e, 1600, "none", clock);
    expect(e.snapshot().state).toBe("PAUSED");
    const snap = step(e, 3200, "none", clock);
    expect(snap.state).toBe("IDLE");
    expect(snap.score.left).toBe(0); // match abandoned
  });

  it("ends the match after 9 rounds and stays until playAgain", () => {
    const e = new GameEngine();
    e.setCatalog(catalogOf(10, MATCH_TARGET));
    const clock = { t: 1000 };
    e.update(packet("both-match"), clock.t);
    step(e, 2000, "both-match", clock);
    step(e, 3000, "both-match", clock);
    // Each 500ms of both-match scores exactly one round.
    const snap = step(e, 9 * 600, "both-match", clock);
    expect(snap.state).toBe("GAME_OVER");
    expect(snap.winner).not.toBeNull();
    // No auto-reset: the result screen is sticky even after 10s.
    const stuck = step(e, 10000, "both-match", clock);
    expect(stuck.state).toBe("GAME_OVER");
    expect(stuck.score.left).toBeGreaterThan(0);
    // Replay button returns a clean IDLE.
    clock.t += 100;
    e.playAgain(clock.t);
    const back = e.snapshot();
    expect(back.state).toBe("IDLE");
    expect(back.score).toEqual({ left: 0, right: 0 });
    expect(back.currentPose).toBeNull();
  });

  it("resetToIdle returns a clean state", () => {
    const e = new GameEngine();
    e.setCatalog(catalogOf(10, MATCH_TARGET));
    const clock = { t: 1000 };
    e.update(packet("both-match"), clock.t);
    step(e, 2500, "both-match", clock);
    e.resetToIdle();
    const snap = e.snapshot();
    expect(snap.state).toBe("IDLE");
    expect(snap.score).toEqual({ left: 0, right: 0 });
    expect(snap.currentPose).toBeNull();
  });
});
