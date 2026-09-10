/**
 * Pose Web Worker: owns two MediaPipe PoseLandmarker detectors (VIDEO mode,
 * numPoses=1) — one per fixed half-frame crop. Accepts one inference at a
 * time; drops new frames while busy so no queue lag builds up.
 *
 * Main thread protocol:
 *   { type: "init", wasmUrl, modelUrl } -> { type: "ready" } | { type: "error", message }
 *   { type: "frame", timestampMs, left: ImageBitmap, right: ImageBitmap }
 *     -> { type: "packet", packet: VisionPacket }
 */

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

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
    minTrackingConfidence: 0.4,
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
    // Warm-up not possible without a frame; report ready.
    self.postMessage({ type: "ready" });
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
    const ts = Math.max(1, Math.round(timestampMs));
    const l = leftDetector.detectForVideo(left, ts);
    const r = rightDetector.detectForVideo(right, ts);
    self.postMessage({
      type: "packet",
      packet: {
        timestampMs,
        left: toDetection(l as never, timestampMs),
        right: toDetection(r as never, timestampMs),
      },
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
