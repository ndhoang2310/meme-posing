import type { VisionPacket } from "../app/types";
import PoseWorker from "./pose-worker?worker";

export type WorkerStatus = "idle" | "loading" | "ready" | "error";

interface WorkerPacketMsg {
  type: "packet";
  packet: VisionPacket;
}

interface WorkerReadyMsg {
  type: "ready";
  model?: string;
}

interface WorkerErrorMsg {
  type: "error";
  message: string;
}

type WorkerMsg = WorkerPacketMsg | WorkerReadyMsg | WorkerErrorMsg;

/**
 * Main-thread client for the pose worker. Tracks busy state so the frame
 * pipeline can drop frames while inference is running (no queue lag).
 */
export class PoseWorkerClient {
  private worker: Worker | null = null;
  private busy = false;
  private packetHandler: ((p: VisionPacket) => void) | null = null;
  private statusHandler: ((s: WorkerStatus, message?: string) => void) | null = null;

  get isBusy(): boolean {
    return this.busy;
  }

  get isReady(): boolean {
    return this.worker != null && this.status === "ready";
  }

  status: WorkerStatus = "idle";

  /** Model filename reported by the worker at init (for debug display). */
  modelLabel = "?";

  onPacket(handler: (p: VisionPacket) => void): void {
    this.packetHandler = handler;
  }

  onStatus(handler: (s: WorkerStatus, message?: string) => void): void {
    this.statusHandler = handler;
  }

  private setStatus(s: WorkerStatus, message?: string): void {
    this.status = s;
    this.statusHandler?.(s, message);
  }

  async init(opts?: { wasmUrl?: string; modelUrl?: string }): Promise<void> {
    this.terminate();
    this.setStatus("loading");
    // WASM + model are bundled locally so the booth works offline — no CDN
    // dependency at event time. Default is the LITE model (5.7MB, ~3x faster
    // inference than full; plenty accurate for 4 upper-body joint angles).
    // Override via env (baked in at build time):
    // - full local model:  VITE_MODEL_URL=/models/pose_landmarker.task
    // - Cloudflare R2 full: VITE_MODEL_URL=https://pub-xxx.r2.dev/pose_landmarker.task
    // (the 30MB full .task exceeds Pages' 25MB/file limit -> R2 only for full).
    const wasmUrl = opts?.wasmUrl ?? import.meta.env.VITE_WASM_URL ?? "/wasm";
    const modelUrl =
      opts?.modelUrl ?? import.meta.env.VITE_MODEL_URL ?? "/models/pose_landmarker_lite.task";
    this.worker = new PoseWorker();
    await new Promise<void>((resolve, reject) => {
      const w = this.worker;
      if (!w) {
        reject(new Error("worker unavailable"));
        return;
      }
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("pose worker init timeout"));
      }, 30000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        w.removeEventListener("message", onMsg);
        w.removeEventListener("error", onErr);
      };
      const onMsg = (ev: MessageEvent<WorkerMsg>) => {
        if (ev.data?.type === "ready") {
          cleanup();
          this.modelLabel = (ev.data as WorkerReadyMsg).model ?? "?";
          this.setStatus("ready");
          w.addEventListener("message", this.handleMessage);
          w.addEventListener("error", this.handleError);
          resolve();
        } else if (ev.data?.type === "error") {
          cleanup();
          this.setStatus("error", (ev.data as WorkerErrorMsg).message);
          reject(new Error((ev.data as WorkerErrorMsg).message));
        }
      };
      const onErr = (ev: ErrorEvent) => {
        cleanup();
        this.setStatus("error", ev.message);
        reject(new Error(ev.message));
      };
      w.addEventListener("message", onMsg);
      w.addEventListener("error", onErr);
      w.postMessage({ type: "init", wasmUrl, modelUrl });
    });
  }

  private handleMessage = (ev: MessageEvent<WorkerMsg>) => {
    const msg = ev.data;
    if (msg?.type === "packet") {
      this.busy = false;
      this.packetHandler?.(msg.packet);
    } else if (msg?.type === "error") {
      this.busy = false;
      this.setStatus("error", msg.message);
    }
  };

  private handleError = (ev: ErrorEvent) => {
    this.busy = false;
    this.setStatus("error", ev.message);
  };

  /**
   * Send half-frame crops. Ownership of the bitmaps transfers to the worker.
   * Returns false when the frame was dropped (worker busy / not ready).
   */
  sendFrame(timestampMs: number, left: ImageBitmap, right: ImageBitmap): boolean {
    if (!this.worker || this.status !== "ready" || this.busy) {
      // Caller keeps ownership on drop — close to avoid leaks.
      try { left.close(); } catch { /* noop */ }
      try { right.close(); } catch { /* noop */ }
      return false;
    }
    this.busy = true;
    this.worker.postMessage(
      { type: "frame", timestampMs, left, right },
      [left, right],
    );
    return true;
  }

  terminate(): void {
    try {
      this.worker?.postMessage({ type: "close" });
    } catch { /* noop */ }
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.status = "idle";
  }
}
