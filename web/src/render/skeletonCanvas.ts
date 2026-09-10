import { GAME_CONFIG } from "../app/game-config";
import type { PlayerDetection } from "../app/types";

// MediaPipe pose connections (upper body only — matches UPPER_BODY_ONLY).
const CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
];

export function skeletonColor(similarity: number): string {
  if (similarity >= GAME_CONFIG.skeletonYellowBelow) return "#39ff6a"; // green
  if (similarity >= GAME_CONFIG.skeletonWhiteBelow) return "#ffd23f"; // yellow
  return "#ffffff";
}

/**
 * Draw the upper-body skeleton for one half-frame panel.
 * Landmarks are crop-local normalized (0..1); panel maps to
 * (panelX, 0, panelW, canvasH).
 */
export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  detection: PlayerDetection | null,
  panelX: number,
  panelW: number,
  canvasH: number,
  similarity: number,
  holdProgress: number, // 0..1 ring around the head when on-threshold
): void {
  if (!detection) return;
  const color = skeletonColor(similarity);
  const px = (nx: number) => panelX + nx * panelW;
  const py = (ny: number) => ny * canvasH;

  // Bounding box from crop-local normalized coords.
  const bb = detection.boundingBox;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = Math.max(2, panelW * 0.004);
  ctx.strokeRect(px(bb.x), py(bb.y), bb.width * panelW, bb.height * canvasH);
  ctx.restore();

  const pts = detection.landmarks;
  const at = (i: number) => {
    const lm = pts[i];
    return lm ? { x: px(lm.x), y: py(lm.y) } : null;
  };

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(3, panelW * 0.007);
  ctx.lineCap = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;

  ctx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    const pa = at(a);
    const pb = at(b);
    if (!pa || !pb) continue;
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();

  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24]) {
    const p = at(i);
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(3, panelW * 0.006), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Hold progress ring around the nose/head.
  if (holdProgress > 0) {
    const head = at(0);
    if (head) {
      const r = Math.max(18, panelW * 0.035);
      ctx.save();
      ctx.strokeStyle = "#39ff6a";
      ctx.lineWidth = 5;
      ctx.shadowColor = "#39ff6a";
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(head.x, head.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * holdProgress);
      ctx.stroke();
      ctx.restore();
    }
  }
}
