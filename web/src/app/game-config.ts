// Locked gameplay tuning — mirrors src/config.py + GDD section 1.
export const GAME_CONFIG = {
  /** 4 upper-body joint angles: left elbow, right elbow, left shoulder, right shoulder. */
  similarityThreshold: 0.8,
  holdDurationMs: 400,
  totalRounds: 9,
  poseTimeoutMs: 6000,
  gameDurationMs: 54000, // 9 x 6s safety timer
  countdownMs: 3000,
  lostTrackingPauseMs: 1500,
  idleStableMs: 2000,
  pauseTimeoutMs: 3000,
  gameOverHoldMs: 5000,
  /** Skeleton colors by displayed similarity. Scoring still uses 0.8. */
  skeletonWhiteBelow: 0.72,
  skeletonYellowBelow: 0.88,
  /** Clamp per-frame dt so a laggy tab cannot jump timers. */
  maxDtMs: 100,
} as const;

export type GameConfig = typeof GAME_CONFIG;
