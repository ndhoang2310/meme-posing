/**
 * Pose Web Worker: owns two MediaPipe PoseLandmarker detectors (VIDEO mode,
 * numPoses=1) — one per fixed half-frame crop. Accepts one inference at a
 * time; drops new frames while busy so no queue lag builds up.
 *
 * Main thread protocol:
 *   { type: "init", wasmUrl, modelUrl } -> { type: "ready", model } | { type: "error", message }
 *   { type: "frame", timestampMs, left: ImageBitmap, right: ImageBitmap }
 *     -> { type: "packet", packet: VisionPacket }
 */

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import {
  SPARSE_PHASE_LEFT,
  SPARSE_PHASE_RIGHT,
  shouldRunHalf,
} from "./detectionScheduler";

type Landmarker = PoseLandmarker;

interface InitMsg {
  type: "init";
  wasmUrl: string;
  modelUrl: string;
}

interface FrameMsg {
  type: "frame";
  timestampMs: number;
  left: ImageBitmap;
  right: ImageBitmap;
}

let leftDetector: Landmarker | null = null;
let rightDetector: Landmarker | null = null;
let busy = false;
let closed = false;
// Asymmetric scheduling state (see detectionScheduler): idle halves are
// checked sparsely so the tracked half gets (nearly) full inference rate.
let frameSeq = 0;
let nullRunL = 0;
let nullRunR = 0;

function makeDetector(
  modelPath: string,
  vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
): Promise<Landmarker> {
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: modelPath, delegate: "CPU" },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    // Low-ish tracking threshold: keep the track alive through momentary
    // dips (lighting/motion) instead of dropping to re-detect every second.
    // Jitter from looser tracks is absorbed by the main-thread smoother.
    minTrackingConfidence: 0.3,
  });
}

function toDetection(result: {
  landmarks?: { x: number; y: number; z: number; visibility?: number }[][];
  landmarksPresences?: { presence?: { value?: number } }[][];
}, timestampMs: number) {
  const pose = result.landmarks?.[0];
  if (!pose || pose.length < 29) return null;
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const lm of pose) {
    if (lm.x < minX) minX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y > maxY) maxY = lm.y;
  }
  return {
    landmarks: pose.map((lm) => ({
      x: lm.x,
      y: lm.y,
      z: lm.z ?? 0,
      visibility: lm.visibility,
    })),
    boundingBox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    detected: true as const,
    timestampMs,
  };
}

async function handleInit(msg: InitMsg) {
  try {
    const vision = await FilesetResolver.forVisionTasks(msg.wasmUrl);
    leftDetector = await makeDetector(msg.modelUrl, vision);
    rightDetector = await makeDetector(msg.modelUrl, vision);
    // Warm-up not possible without a frame; report ready (+ model label for debug).
    const model = msg.modelUrl.split("/").pop() ?? msg.modelUrl;
    self.postMessage({ type: "ready", model });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function handleFrame(msg: FrameMsg) {
  const { left, right, timestampMs } = msg;
  if (busy || closed || !leftDetector || !rightDetector) {
    // Drop the frame but always release the bitmaps — no memory leak.
    try { left.close(); } catch { /* noop */ }
    try { right.close(); } catch { /* noop */ }
    if (!leftDetector || !rightDetector) {
      // Not initialized yet: tell main thread nothing is available yet.
    }
    return;
  }
  busy = true;
  try {
    frameSeq++;
    const ts = Math.max(1, Math.round(timestampMs));
    // Idle halves run sparsely; skipped halves report null this packet.
    const runL = shouldRunHalf(nullRunL, frameSeq, SPARSE_PHASE_LEFT);
    const runR = shouldRunHalf(nullRunR, frameSeq, SPARSE_PHASE_RIGHT);
    const lDet = runL
      ? toDetection(leftDetector.detectForVideo(left, ts) as never, timestampMs)
      : null;
    const rDet = runR
      ? toDetection(rightDetector.detectForVideo(right, ts) as never, timestampMs)
      : null;
    if (runL) nullRunL = lDet ? 0 : nullRunL + 1;
    if (runR) nullRunR = rDet ? 0 : nullRunR + 1;
    self.postMessage({
      type: "packet",
      packet: { timestampMs, left: lDet, right: rDet },
    });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    try { left.close(); } catch { /* noop */ }
    try { right.close(); } catch { /* noop */ }
    busy = false;
  }
}

self.onmessage = (ev: MessageEvent<InitMsg | FrameMsg | { type: "close" }>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "init") {
    void handleInit(msg as InitMsg);
  } else if (msg.type === "frame") {
    handleFrame(msg as FrameMsg);
  } else if (msg.type === "close") {
    closed = true;
    try { leftDetector?.close(); } catch { /* noop */ }
    try { rightDetector?.close(); } catch { /* noop */ }
    leftDetector = null;
    rightDetector = null;
  }
};

export {};
