import { GAME_CONFIG } from "../app/game-config";

interface Props {
  scoreLeft: number;
  scoreRight: number;
  gameRemainingMs: number;
  poseRemainingMs: number;
  roundNumber: number;
  totalRounds: number;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${s}s`;
}

export function GameHud({
  scoreLeft,
  scoreRight,
  gameRemainingMs,
  poseRemainingMs,
  roundNumber,
  totalRounds,
}: Props) {
  const poseFrac = Math.max(0, Math.min(1, poseRemainingMs / GAME_CONFIG.poseTimeoutMs));
  return (
    <header className="hud">
      <div className="hud-score hud-left">P1 · {scoreLeft}</div>
      <div className="hud-center">
        <div className="hud-timers">
          <span className="hud-game-time">⏱ {fmt(gameRemainingMs)}</span>
          <span className="hud-round">
            {Math.max(roundNumber, 1)}/{totalRounds}
          </span>
        </div>
        <div className="pose-progress">
          <div className="pose-progress-fill" style={{ width: `${poseFrac * 100}%` }} />
        </div>
      </div>
      <div className="hud-score hud-right">{scoreRight} · P2</div>
    </header>
  );
}
