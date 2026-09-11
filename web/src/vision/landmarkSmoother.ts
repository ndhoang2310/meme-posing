import type { BoundingBox, Landmark, PlayerDetection } from "../app/types";

interface Pose {
  lms: Landmark[];
  box: BoundingBox;
}

/**
 * Per-side temporal smoothing for pose detections.
 *
 * Problem: inference (~3-10 det/s, worse on weak CPUs) runs far slower than
 * the display loop (60fps). Redrawing the same frozen pose between packets
 * makes the skeleton JUMP rhythmically ("chớp theo nhịp").
 *
 * Motion is deliberately UNSMOOTHED (no interpolation): each new packet is
 * displayed as-is so the skeleton tracks the player with zero added lag.
 * At slow detection rates motion looks steppy — accepted trade-off per booth
 * feedback. Anti-flicker (debounce + grace freeze + presence fade) is kept,
 * so nothing pops in/out: only motion stepping remains.
 *
 * Anti-flicker debounce: a single phantom detection (background object
 * mistaken for a person for 1-2 frames) must NOT pop the skeleton/dim in and
 * out. Display flips to "present" only after SHOW_AFTER_MS of continuous
 * detection; flips back to "absent" after the grace window of continuous
 * loss. Genuine tracking is unaffected (only transitions are delayed).
 *
 * Call `update()` once per render tick with the latest detection (or null).
 * One instance per side — it holds that side's filter state.
 */
/** Continuous detection time before a new presence is displayed. */
export const SHOW_AFTER_MS = 250;

export class DetectionSmoother {
  private from: Pose | null = null;
  private to: Pose | null = null;
  private glideStart = 0;
  private glideDur = 200;
  private lastPktAt = 0;
  private lastDetTs = -1;
  private lastSeenMs = -Infinity;
  private detSinceMs = 0;
  private wasNull = true;
  // Visual presence 0..1 for fade in/out (see getPresence). Attack fast so
  // appearance feels instant; release slow so disappearance dissolves instead
  // of blinking. Game LOGIC still uses the binary update() return value.
  private level = 0;
  private prevTickMs = 0;

  /** @param graceMs how long to freeze the last pose after a lost frame. */
  constructor(private graceMs = 350) {}

  /** Tune the dropout grace at runtime. */
  setGraceMs(ms: number): void {
    this.graceMs = Math.max(0, ms);
  }

  /** Continuous presence for visuals: 1 = fully shown, 0 = fully dimmed. */
  getPresence(): number {
    return Math.min(1, Math.max(0, this.level));
  }

  reset(): void {
    this.from = null;
    this.to = null;
    this.lastPktAt = 0;
    this.lastDetTs = -1;
    this.lastSeenMs = -Infinity;
    this.detSinceMs = 0;
    this.wasNull = true;
    this.level = 0;
    this.prevTickMs = 0;
  }

  update(det: PlayerDetection | null, nowMs: number): PlayerDetection | null {
    // Presence fade runs on every tick, independent of logic gating below.
    const dt = this.prevTickMs > 0 ? Math.min(100, Math.max(0, nowMs - this.prevTickMs)) : 0;
    this.prevTickMs = nowMs;
    const has = det !== null && det.landmarks.length > 0;
    const tau = has ? 150 : 700;
    this.level += ((has ? 1 : 0) - this.level) * Math.min(1, dt / tau);

    if (det && det.landmarks.length > 0) {
      if (this.wasNull) {
        this.detSinceMs = nowMs;
        this.wasNull = false;
      }
      this.lastSeenMs = nowMs;
      // Probation: a brand-new presence must prove itself stable before it
      // is displayed — single phantom frames never reach the screen.
      // The glide target still advances underneath so flip-on is current.
      if (nowMs - this.detSinceMs >= SHOW_AFTER_MS) {
        // New packet? (Same packet is re-fed every tick — only shift on arrival.)
        // No glide: snap straight to the new sample (from == to).
        if (det.timestampMs !== this.lastDetTs) {
          this.lastDetTs = det.timestampMs;
          this.lastPktAt = nowMs;
          this.from = sampleOf(det);
          this.to = sampleOf(det);
          this.glideStart = nowMs;
          this.glideDur = 1;
        }
      } else if (this.lastDetTs === -1) {
        // Never displayed anything yet: keep advancing the anchor clock so
        // the first glide doesn't inherit a stale gap.
        this.lastPktAt = nowMs;
      }
    } else {
      this.wasNull = true;
      if (this.to === null || nowMs - this.lastSeenMs > this.graceMs) {
        if (this.to !== null && nowMs - this.lastSeenMs > this.graceMs) {
          this.from = null;
          this.to = null;
        }
        if (this.to === null) return null;
      }
    }
    const pose = this.rendered(nowMs);
    if (!pose) return null;
    return {
      landmarks: pose.lms,
      boundingBox: pose.box,
      detected: true,
      timestampMs: det?.timestampMs ?? nowMs,
    };
  }

  /** Current displayed pose along the glide (smoothstep easing). */
  private rendered(nowMs: number): Pose | null {
    if (!this.to) return null;
    if (!this.from) return { lms: this.to.lms.map(cloneLm), box: { ...this.to.box } };
    let f = (nowMs - this.glideStart) / Math.max(1, this.glideDur);
    f = f <= 0 ? 0 : f >= 1 ? 1 : f * f * (3 - 2 * f);
    const lms = this.to.lms.map((lm, i) => {
      const p = this.from?.lms[i];
      if (!p) return cloneLm(lm);
      return {
        x: p.x + (lm.x - p.x) * f,
        y: p.y + (lm.y - p.y) * f,
        z: p.z + (lm.z - p.z) * f,
        visibility: lm.visibility,
      };
    });
    const a = this.from.box;
    const b = this.to.box;
    return {
      lms,
      box: {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        width: a.width + (b.width - a.width) * f,
        height: a.height + (b.height - a.height) * f,
      },
    };
  }
}

function cloneLm(lm: Landmark): Landmark {
  return { x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility };
}

function sampleOf(det: PlayerDetection): Pose {
  return {
    lms: det.landmarks.map(cloneLm),
    box: { ...det.boundingBox },
  };
}
