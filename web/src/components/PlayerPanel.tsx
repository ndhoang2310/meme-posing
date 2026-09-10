import type { GameSide } from "../app/types";

interface Props {
  side: GameSide;
  score: number;
  similarity: number; // 0..1
  detected: boolean;
  holdProgress: number; // 0..1
  lastScorer: GameSide | null;
}

export function PlayerPanel({ side, score, similarity, detected, holdProgress, lastScorer }: Props) {
  const isLeft = side === "left";
  const label = isLeft ? "P1" : "P2";
  const pct = Math.round(similarity * 100);
  const pulse = lastScorer === side ? " panel-score-pop" : "";
  return (
    <div className={`player-panel ${isLeft ? "panel-left" : "panel-right"}`}>
      <div className="panel-head">
        <span className="panel-name">{label}</span>
        <span className={`panel-score${pulse}`} key={`${side}-${score}`}>
          {score}
        </span>
      </div>
      <div className="panel-sim">
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
      <div className="panel-status">
        {detected ? (pct >= 80 ? "KHỚP POSE — GIỮ NGUYÊN!" : "Bắt chước pose giữa màn hình") : "Đang tìm người chơi…"}
      </div>
    </div>
  );
}
