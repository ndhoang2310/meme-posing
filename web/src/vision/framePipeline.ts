import type { VisionPacket } from "../app/types";
import type { PoseWorkerClient } from "./poseWorkerClient";

/**
 * Per-video-frame pipeline (called from requestAnimationFrame):
 * 1. Draw the mirrored camera frame onto the display canvas (cover-fit 16:9).
 * 2. Slice the same mirrored frame into left/right halves and transfer them
 *    to the pose worker — dropped automatically when the worker is busy.
 * 3. Feed the latest VisionPacket into the game engine.
 *
 * Inference and display share the same mirrored frame, so P1/P2 sides match.
 */

export interface PipelineCallbacks {
  engine: { update: (packet: VisionPacket | null, nowMs: number) => unknown };
  getPacket: () => VisionPacket | null;
}

const scratch = document.createElement("canvas");

/** Compute cover-fit draw rect of video into a canvas (object-fit: cover). */
export function coverRect(
  videoW: number,
  videoH: number,
  canvasW: number,
  canvasH: number,
): { dx: number; dy: number; dw: number; dh: number } {
  const scale = Math.max(canvasW / videoW, canvasH / videoH);
  const dw = videoW * scale;
  const dh = videoH * scale;
  return { dx: (canvasW - dw) / 2, dy: (canvasH - dh) / 2, dw, dh };
}

export function drawMirroredCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  canvasW: number,
  canvasH: number,
): void {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const { dx, dy, dw, dh } = coverRect(vw, vh, canvasW, canvasH);
  ctx.save();
  ctx.translate(canvasW, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, dx, dy, dw, dh);
  ctx.restore();
}

/**
 * Crop the mirrored display canvas into two half bitmaps for the worker.
 * Uses the same transform as display so skeleton overlays line up.
 */
export async function sliceHalves(
  display: HTMLCanvasElement,
): Promise<[ImageBitmap, ImageBitmap]> {
  const halfW = Math.floor(display.width / 2);
  const h = display.height;
  const left = await createImageBitmap(display, 0, 0, halfW, h);
  const right = await createImageBitmap(display, halfW, 0, display.width - halfW, h);
  return [left, right];
}

export async function pumpFrame(
  video: HTMLVideoElement,
  display: HTMLCanvasElement,
  workerClient: PoseWorkerClient,
  // Half-frame width fed to the detector. 480px is plenty for upper-body
  // poses and ~1.8x cheaper than 640 (cost scales with pixels).
  maxInferenceWidth = 480,
): Promise<void> {
  const ctx = display.getContext("2d");
  if (!ctx) return;
  drawMirroredCover(ctx, video, display.width, display.height);
  if (workerClient.isBusy || !workerClient.isReady) return;

  // Downscale halves for inference to bound worker cost.
  const halfW = Math.floor(display.width / 2);
  const scale = Math.min(1, maxInferenceWidth / halfW);
  const iw = Math.max(2, Math.floor(halfW * scale));
  const ih = Math.max(2, Math.floor(display.height * scale));
  scratch.width = iw;
  scratch.height = ih;
  const sctx = scratch.getContext("2d");
  if (!sctx) return;
  sctx.drawImage(display, 0, 0, halfW, display.height, 0, 0, iw, ih);
  const leftHalf = await createImageBitmap(scratch);
  sctx.drawImage(
    display, halfW, 0, display.width - halfW, display.height, 0, 0, iw, ih,
  );
  const rightHalf = await createImageBitmap(scratch);
  workerClient.sendFrame(performance.now(), leftHalf, rightHalf);
}
