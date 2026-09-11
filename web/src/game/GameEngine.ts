import { GAME_CONFIG } from "../app/game-config";
import type {
  GameSnapshot,
  GameState,
  PoseDefinition,
  VisionPacket,
} from "../app/types";
import { jointAngles, poseMatchSimilarity } from "./poseMath";
import { buildRoundOrder } from "./roundSelector";

/**
 * Pure game logic — no React, DOM, webcam or MediaPipe dependency.
 * Receives the latest VisionPacket + a monotonic timestamp (performance.now()).
 */
export class GameEngine {
  private state: GameState = "IDLE";
  private score = { left: 0, right: 0 };
  private similarity = { left: 0, right: 0 };
  private holdMs = { left: 0, right: 0 };
  private catalog: PoseDefinition[] = [];
  private roundOrder: number[] = [];
  private roundIndex = 0;
  private gameRemainingMs = GAME_CONFIG.gameDurationMs;
  private poseRemainingMs = GAME_CONFIG.poseTimeoutMs;
  private countdownRemainingMs = GAME_CONFIG.countdownMs;
  private idleStableMs = 0;
  private lostPlayerMs = 0;
  private pauseRemainingMs = GAME_CONFIG.pauseTimeoutMs;
  private lastScorer: "left" | "right" | null = null;
  private lastTickMs: number | null = null;

  setCatalog(catalog: PoseDefinition[]): void {
    this.catalog = catalog;
  }

  resetToIdle(): void {
    this.state = "IDLE";
    this.score = { left: 0, right: 0 };
    this.similarity = { left: 0, right: 0 };
    this.holdMs = { left: 0, right: 0 };
    this.roundOrder = [];
    this.roundIndex = 0;
    this.gameRemainingMs = GAME_CONFIG.gameDurationMs;
    this.poseRemainingMs = GAME_CONFIG.poseTimeoutMs;
    this.countdownRemainingMs = GAME_CONFIG.countdownMs;
    this.idleStableMs = 0;
    this.lostPlayerMs = 0;
    this.pauseRemainingMs = GAME_CONFIG.pauseTimeoutMs;
    this.lastScorer = null;
    this.lastTickMs = null;
  }

  /**
   * Leave GAME_OVER for a fresh booth round. Only called from the replay
   * button — the engine never auto-resets, so the result screen stays put
   * until the players ask for a new match.
   */
  playAgain(nowMs: number): void {
    this.resetToIdle();
    // resetToIdle clears lastTickMs; restore so the next dt is sane.
    this.lastTickMs = nowMs;
  }

  /** Called when the tab was hidden / vision restarted — drop stale stability. */
  resetDetectionStability(): void {
    this.idleStableMs = 0;
    this.lostPlayerMs = 0;
    this.holdMs = { left: 0, right: 0 };
  }

  get currentPose(): PoseDefinition | null {
    if (this.roundOrder.length === 0) return null;
    if (this.roundIndex < 0 || this.roundIndex >= this.roundOrder.length) return null;
    return this.catalog[this.roundOrder[this.roundIndex]] ?? null;
  }

  get winner(): "left" | "right" | "draw" | null {
    if (this.state !== "GAME_OVER") return null;
    if (this.score.left > this.score.right) return "left";
    if (this.score.right > this.score.left) return "right";
    return "draw";
  }

  update(packet: VisionPacket | null, nowMs: number): GameSnapshot {
    const last = this.lastTickMs ?? nowMs;
    const dt = Math.min(Math.max(nowMs - last, 0), GAME_CONFIG.maxDtMs);
    this.lastTickMs = nowMs;

    const target = this.currentPose?.targetVector ?? null;
    const leftSim = similarityOf(packet?.left?.landmarks ?? null, target);
    const rightSim = similarityOf(packet?.right?.landmarks ?? null, target);
    this.similarity = { left: leftSim, right: rightSim };

    const leftDetected = packet?.left != null;
    const rightDetected = packet?.right != null;

    switch (this.state) {
      case "IDLE": {
        if (leftDetected && rightDetected) {
          this.idleStableMs += dt;
          if (this.idleStableMs >= GAME_CONFIG.idleStableMs) {
            this.state = "COUNTDOWN";
            this.countdownRemainingMs = GAME_CONFIG.countdownMs;
            this.idleStableMs = 0;
          }
        } else {
          this.idleStableMs = 0;
        }
        break;
      }
      case "COUNTDOWN": {
        this.countdownRemainingMs -= dt;
        if (this.countdownRemainingMs <= 0) {
          this.startMatch();
        }
        break;
      }
      case "PLAYING": {
        this.gameRemainingMs -= dt;
        this.poseRemainingMs -= dt;

        // Per-player hold timers.
        if (leftDetected && leftSim >= GAME_CONFIG.similarityThreshold) {
          this.holdMs.left += dt;
        } else {
          this.holdMs.left = 0;
        }
        if (rightDetected && rightSim >= GAME_CONFIG.similarityThreshold) {
          this.holdMs.right += dt;
        } else {
          this.holdMs.right = 0;
        }

        const leftDone = this.holdMs.left >= GAME_CONFIG.holdDurationMs;
        const rightDone = this.holdMs.right >= GAME_CONFIG.holdDurationMs;
        let scorer: "left" | "right" | null = null;
        if (leftDone && rightDone) {
          scorer = this.holdMs.left >= this.holdMs.right ? "left" : "right";
        } else if (leftDone) {
          scorer = "left";
        } else if (rightDone) {
          scorer = "right";
        }
        if (scorer) {
          this.score[scorer] += 1;
          this.lastScorer = scorer;
          this.advanceRound();
          break; // round advanced; skip timeout/pause checks this tick
        }

        if (this.poseRemainingMs <= 0) {
          this.lastScorer = null;
          this.advanceRound();
          break;
        }
        if (this.gameRemainingMs <= 0) {
          this.finishMatch();
          break;
        }

        if (!leftDetected || !rightDetected) {
          this.lostPlayerMs += dt;
          if (this.lostPlayerMs >= GAME_CONFIG.lostTrackingPauseMs) {
            this.state = "PAUSED";
            this.pauseRemainingMs = GAME_CONFIG.pauseTimeoutMs;
            this.lostPlayerMs = 0;
          }
        } else {
          this.lostPlayerMs = 0;
        }
        break;
      }
      case "PAUSED": {
        this.pauseRemainingMs -= dt;
        if (leftDetected && rightDetected) {
          // Resume with a fresh countdown; score + round kept.
          this.state = "COUNTDOWN";
          this.countdownRemainingMs = GAME_CONFIG.countdownMs;
          this.poseRemainingMs = GAME_CONFIG.poseTimeoutMs;
          this.holdMs = { left: 0, right: 0 };
          this.lostPlayerMs = 0;
          this.lastScorer = null;
          // Re-anchor the match timers on resume so the game clock does not
          // keep the stale pre-pause value; round progress is preserved via roundIndex.
        } else if (this.pauseRemainingMs <= 0) {
          this.resetToIdle();
          // resetToIdle clears lastTickMs; restore so next dt is sane.
          this.lastTickMs = nowMs;
        }
        break;
      }
      case "GAME_OVER": {
        // Result screen is sticky: it stays until playAgain() is called
        // from the replay button. Timers are already frozen by finishMatch.
        break;
      }
    }

    return this.snapshot();
  }

  snapshot(): GameSnapshot {
    const pose = this.currentPose;
    return {
      state: this.state,
      score: { ...this.score },
      currentPose: pose,
      roundNumber:
        this.state === "IDLE"
          ? 0
          : Math.min(this.roundIndex + 1, GAME_CONFIG.totalRounds),
      totalRounds: GAME_CONFIG.totalRounds,
      gameRemainingMs: Math.max(0, this.gameRemainingMs),
      poseRemainingMs: Math.max(0, this.poseRemainingMs),
      countdownRemainingMs: Math.max(0, this.countdownRemainingMs),
      holdMs: { ...this.holdMs },
      similarity: { ...this.similarity },
      winner: this.winner,
      lastScorer: this.lastScorer,
    };
  }

  private startMatch(): void {
    this.roundOrder = buildRoundOrder(this.catalog.length, GAME_CONFIG.totalRounds);
    this.roundIndex = 0;
    this.score = { left: 0, right: 0 };
    this.gameRemainingMs = GAME_CONFIG.gameDurationMs;
    this.poseRemainingMs = GAME_CONFIG.poseTimeoutMs;
    this.holdMs = { left: 0, right: 0 };
    this.lostPlayerMs = 0;
    this.lastScorer = null;
    this.state = "PLAYING";
  }

  private advanceRound(): void {
    this.roundIndex += 1;
    this.holdMs = { left: 0, right: 0 };
    // NOTE: lostPlayerMs intentionally NOT reset here (matches Python FSM),
    // so tracking loss spanning a scored round still triggers PAUSED.
    if (this.roundIndex >= GAME_CONFIG.totalRounds) {
      this.finishMatch();
      return;
    }
    this.poseRemainingMs = GAME_CONFIG.poseTimeoutMs;
  }

  private finishMatch(): void {
    this.state = "GAME_OVER";
    this.holdMs = { left: 0, right: 0 };
  }
}

function similarityOf(
  landmarks: { x: number; y: number; z: number; visibility?: number }[] | null,
  target: [number, number, number, number] | null,
): number {
  if (!landmarks || !target) return 0;
  const angles = jointAngles(landmarks);
  if (!angles) return 0;
  return poseMatchSimilarity(angles, target);
}
