// Locked gameplay tuning — mirrors src/config.py + GDD section 1.
// angleSmoothing/similarityHysteresis are web-only steadiness tuning.
export const GAME_CONFIG = {
  /** 4 upper-body joint angles: left elbow, right elbow, left shoulder, right shoulder. */
  similarityThreshold: 0.7,
  /**
   * Hold hysteresis: a hold starts at similarityThreshold but survives dips
   * down to (threshold - hysteresis). Stops borderline flicker from resetting
   * the hold timer on every noisy lite-model frame.
   */
  similarityHysteresis: 0.08,
  /** EMA weight per tick applied to the 4 scoring angles (steadies lite noise). */
  angleSmoothing: 0.5,
  holdDurationMs: 300,
  totalRounds: 9,
  poseTimeoutMs: 6000,
  gameDurationMs: 54000, // 9 x 6s safety timer
  countdownMs: 3000,
  lostTrackingPauseMs: 1500,
  idleStableMs: 2000,
  pauseTimeoutMs: 3000,
  /** Skeleton colors by displayed similarity. Scoring still uses 0.8. */
  skeletonWhiteBelow: 0.72,
  skeletonYellowBelow: 0.88,
  /** Clamp per-frame dt so a laggy tab cannot jump timers. */
  maxDtMs: 100,
} as const;

export type GameConfig = typeof GAME_CONFIG;
