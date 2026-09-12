import { GAME_CONFIG } from "../app/game-config";
import type { GameSide } from "../app/types";

interface Props {
  side: GameSide;
  score: number;
  similarity: number; // 0..1
  detected: boolean;
  holdProgress: number; // 0..1
}

/**
 * Compact per-player stats floating INSIDE the camera view (one chip per
 * half-frame, top corners) — replaces the old side columns so the camera
 * can use the full booth width.
 */
export function PlayerStatOverlay({ side, score, similarity, detected, holdProgress }: Props) {
  const isLeft = side === "left";
  const pct = Math.round(similarity * 100);
  return (
    <div className={`stat-chip ${isLeft ? "stat-left" : "stat-right"}`}>
      <div className="stat-top">
        <span className="stat-name">{isLeft ? "P1" : "P2"}</span>
        <span className="stat-score">{score}</span>
      </div>
      <div className="stat-sim">
        <div className="sim-bar">
          <div className="sim-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="sim-pct">{pct}%</span>
      </div>
      {holdProgress > 0 && (
        <div className="hold-bar">
          <div className="hold-fill" style={{ width: `${Math.round(holdProgress * 100)}%` }} />
        </div>
      )}
      <div className="stat-status">
        {detected
          ? (similarity >= GAME_CONFIG.similarityThreshold
              ? "KHỚP POSE — GIỮ NGUYÊN!"
              : "Bắt chước pose")
          : "Đang tìm người chơi…"}
      </div>
    </div>
  );
}
