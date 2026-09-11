/**
 * Pose Web Worker (single side): owns ONE MediaPipe PoseLandmarker detector
 * (VIDEO mode, numPoses=1) for a fixed half-frame crop. Two instances of this
 * worker run in parallel — one per side — so a slow/empty half never blocks
 * the tracked half (previously both detectors ran sequentially in one worker).
 *
 * Each instance runs its own sparse schedule (see detectionScheduler) and its
 * own busy flag; frames for the two sides are fully independent.
 *
 * Main thread protocol:
 *   { type: "init", wasmUrl, modelUrl, side }
 *     -> { type: "ready", model } | { type: "error", message }
 *   { type: "frame", timestampMs, bitmap }
 *     -> { type: "packet", packet: { timestampMs, detection } }
 */

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { shouldRunHalf } from "./detectionScheduler";

type Landmarker = PoseLandmarker;

interface InitMsg {
  type: "init";
  wasmUrl: string;
  modelUrl: string;
  side: string;
}

interface FrameMsg {
  type: "frame";
  timestampMs: number;
  bitmap: ImageBitmap;
}

let detector: Landmarker | null = null;
let busy = false;
let closed = false;
let frameSeq = 0;
let nullRun = 0;
let side = "?";

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
  side = msg.side;
  try {
    const vision = await FilesetResolver.forVisionTasks(msg.wasmUrl);
    detector = await makeDetector(msg.modelUrl, vision);
    // Warm-up not possible without a frame; report ready (+ model for debug).
    const model = msg.modelUrl.split("/").pop() ?? msg.modelUrl;
    self.postMessage({ type: "ready", model });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: `[${side}] ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function handleFrame(msg: FrameMsg) {
  const { bitmap, timestampMs } = msg;
  const release = () => {
    try { bitmap.close(); } catch { /* noop */ }
  };
  if (busy || closed || !detector) {
    // Drop the frame but always release the bitmap — no memory leak.
    release();
    return;
  }
  busy = true;
  try {
    frameSeq++;
    const ts = Math.max(1, Math.round(timestampMs));
    // Idle side runs sparsely; skipped packets report null.
    const run = shouldRunHalf(nullRun, frameSeq, 0);
    const det = run
      ? toDetection(detector.detectForVideo(bitmap, ts) as never, timestampMs)
      : null;
    if (run) nullRun = det ? 0 : nullRun + 1;
    self.postMessage({ type: "packet", packet: { timestampMs, detection: det } });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: `[${side}] ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    release();
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
    try { detector?.close(); } catch { /* noop */ }
    detector = null;
  }
};

export {};
