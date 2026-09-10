import type { PoseDefinition } from "../app/types";

interface Props {
  pose: PoseDefinition | null;
  roundNumber: number;
  totalRounds: number;
}

export function TargetPoseCard({ pose, roundNumber, totalRounds }: Props) {
  return (
    <div className="target-card">
      <div className="target-round">
        LƯỢT {Math.max(roundNumber, 1)}/{totalRounds}
      </div>
      {pose ? (
        <img
          key={pose.id}
          className="target-img target-swap"
          src={pose.imageUrl}
          alt={`Target pose ${pose.id}`}
          draggable={false}
        />
      ) : (
        <div className="target-empty">—</div>
      )}
      <div className="target-label">BẮT CHƯỚC POSE NÀY</div>
    </div>
  );
}
