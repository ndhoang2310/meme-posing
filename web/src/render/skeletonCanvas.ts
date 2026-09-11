import type { PlayerDetection } from "../app/types";

/** Player accents — match the CSS vars --cyan/--pink and Python P1/P2. */
export const ACCENT_LEFT = "#00e5ff";
export const ACCENT_RIGHT = "#ff2d78";
const DOT_CENTER = "#070b16"; // dark joint core, like Python's hollow dots

// Upper-body connections only — 1:1 with Python renderer's UPPER_BODY_ONLY set:
// arms (11-13-15, 12-14-16), torso sides (11-23, 12-24), hips (23-24),
// collar (11-12). No face/head dots.
const CONNECTIONS: [number, number][] = [
  [11, 13], [13, 15],
  [12, 14], [14, 16],
  [11, 23], [12, 24],
  [23, 24],
  [11, 12],
];

const KEYPOINTS = [11, 12, 13, 14, 15, 16, 23, 24];

/**
 * Draw the upper-body skeleton for one half-frame panel, Python-style:
 * fixed side accent, thick round limbs, hollow joint dots, rounded bbox.
 * Landmarks are crop-local normalized (0..1); panel maps to
 * (panelX, 0, panelW, canvasH).
 */
export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  detection: PlayerDetection | null,
  panelX: number,
  panelW: number,
  canvasH: number,
  accent: string,
  alpha = 1,
): void {
  if (!detection || alpha <= 0.02) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  const px = (nx: number) => panelX + nx * panelW;
  const py = (ny: number) => ny * canvasH;

  // Bounding box from crop-local normalized coords.
  const bb = detection.boundingBox;
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(px(bb.x), py(bb.y), bb.width * panelW, bb.height * canvasH, 6);
  } else {
    ctx.rect(px(bb.x), py(bb.y), bb.width * panelW, bb.height * canvasH); // Safari < 16
  }
  ctx.stroke();
  ctx.restore();

  const pts = detection.landmarks;
  const at = (i: number) => {
    const lm = pts[i];
    return lm ? { x: px(lm.x), y: py(lm.y) } : null;
  };

  const limbW = Math.max(2, panelW * 0.0045);
  const dotR = Math.max(3, panelW * 0.0065);

  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = limbW;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    const pa = at(a);
    const pb = at(b);
    if (!pa || !pb) continue;
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();

  // Hollow joint dots: accent ring + dark core.
  ctx.fillStyle = accent;
  for (const i of KEYPOINTS) {
    const p = at(i);
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = DOT_CENTER;
  for (const i of KEYPOINTS) {
    const p = at(i);
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotR * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.restore(); // outer alpha wrap
}


