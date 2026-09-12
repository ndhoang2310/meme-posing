import type { PlayerDetection, VisionPacket } from "../app/types";
import PoseWorker from "./pose-worker?worker";

export type WorkerStatus = "idle" | "loading" | "ready" | "error";

interface SidePacket {
  timestampMs: number;
  detection: PlayerDetection | null;
}

interface WorkerPacketMsg {
  type: "packet";
  packet: SidePacket;
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
 * Main-thread client for the pose workers. Owns TWO worker instances — one
 * detector per half-frame, each on its own thread — so a slow/empty half
 * never blocks the tracked half. Each side has an independent busy flag:
 * frames are dropped per side (never queued), and the latest detection per
 * side is merged into one VisionPacket for the game loop.
 *
 * Cost: ~2x WASM/model memory (one runtime per worker). Worth it on any
 * multi-core booth machine; on a saturated dual-core the gain is smaller
 * (threads still contend) but never slower than sequential.
 */
export class PoseWorkerClient {
  private left: Worker | null = null;
  private right: Worker | null = null;
  private busyL = false;
  private busyR = false;
  private detL: PlayerDetection | null = null;
  private detR: PlayerDetection | null = null;
  private tsL = 0;
  private tsR = 0;
  private packetHandler: ((p: VisionPacket) => void) | null = null;
  private statusHandler: ((s: WorkerStatus, message?: string) => void) | null = null;

  /** True only when BOTH sides are busy (nothing can be sent). */
  get isBusy(): boolean {
    return this.busyL && this.busyR;
  }

  get isReady(): boolean {
    return this.left != null && this.right != null && this.status === "ready";
  }

  status: WorkerStatus = "idle";

  /** Model filename reported by the workers at init (for debug display). */
  modelLabel = "?";

  /** Cumulative per-side packet counters (debug: proves both workers produce). */
  packetsL = 0;
  packetsR = 0;

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

  private emit(): void {
    this.packetHandler?.({
      timestampMs: Math.max(this.tsL, this.tsR),
      left: this.detL,
      right: this.detR,
    });
  }

  async init(opts?: { wasmUrl?: string; modelUrl?: string }): Promise<void> {
    this.terminate();
    this.setStatus("loading");
    // WASM + model are bundled locally so the booth works offline —
    // no CDN dependency at event time. Default is the LITE model (5.7MB,
    // ~3x faster inference than full; plenty accurate for 4 upper-body
    // joint angles). Override via env (baked in at build time), e.g. full
    // model on R2 (the 30MB full .task is NOT shipped in dist/).
    const wasmUrl = opts?.wasmUrl ?? import.meta.env.VITE_WASM_URL ?? "/wasm";
    const modelUrl =
      opts?.modelUrl ?? import.meta.env.VITE_MODEL_URL ?? "/models/pose_landmarker_lite.task";
    // Named so DevTools -> Sources -> Threads shows two distinct workers.
    this.left = new PoseWorker({ name: "pose-left" });
    this.right = new PoseWorker({ name: "pose-right" });
    // Both inits run in parallel; wall time ~= slowest single init.
    await Promise.all([
      this.initSide(this.left, "left", wasmUrl, modelUrl),
      this.initSide(this.right, "right", wasmUrl, modelUrl),
    ]);
    this.setStatus("ready");
  }

  private initSide(w: Worker, side: "left" | "right", wasmUrl: string, modelUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error(`pose worker (${side}) init timeout`));
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
          w.addEventListener("message", side === "left" ? this.onLeftPacket : this.onRightPacket);
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
      w.postMessage({ type: "init", wasmUrl, modelUrl, side });
    });
  }

  private onLeftPacket = (ev: MessageEvent<WorkerMsg>): void => {
    const msg = ev.data;
    if (msg?.type === "packet") {
      this.busyL = false;
      this.packetsL += 1;
      this.detL = msg.packet.detection;
      this.tsL = msg.packet.timestampMs;
      this.emit();
    } else if (msg?.type === "error") {
      this.busyL = false;
      this.setStatus("error", msg.message);
    }
  };

  private onRightPacket = (ev: MessageEvent<WorkerMsg>): void => {
    const msg = ev.data;
    if (msg?.type === "packet") {
      this.busyR = false;
      this.packetsR += 1;
      this.detR = msg.packet.detection;
      this.tsR = msg.packet.timestampMs;
      this.emit();
    } else if (msg?.type === "error") {
      this.busyR = false;
      this.setStatus("error", msg.message);
    }
  };

  private handleError = (ev: ErrorEvent): void => {
    this.busyL = false;
    this.busyR = false;
    this.setStatus("error", ev.message);
  };

  /**
   * Send half-frame crops, one bitmap per worker. Each side is accepted or
   * dropped independently (dropped bitmaps are closed to avoid leaks).
   * Returns false when neither side could take the frame.
   */
  sendFrame(timestampMs: number, left: ImageBitmap, right: ImageBitmap): boolean {
    if (!this.left || !this.right || this.status !== "ready") {
      try { left.close(); } catch { /* noop */ }
      try { right.close(); } catch { /* noop */ }
      return false;
    }
    let sent = false;
    if (!this.busyL) {
      this.busyL = true;
      this.left.postMessage({ type: "frame", timestampMs, bitmap: left }, [left]);
      sent = true;
    } else {
      try { left.close(); } catch { /* noop */ }
    }
    if (!this.busyR) {
      this.busyR = true;
      this.right.postMessage({ type: "frame", timestampMs, bitmap: right }, [right]);
      sent = true;
    } else {
      try { right.close(); } catch { /* noop */ }
    }
    return sent;
  }

  terminate(): void {
    for (const w of [this.left, this.right]) {
      try {
        w?.postMessage({ type: "close" });
      } catch { /* noop */ }
      w?.terminate();
    }
    this.left = null;
    this.right = null;
    this.busyL = false;
    this.busyR = false;
    this.detL = null;
    this.detR = null;
    this.packetsL = 0;
    this.packetsR = 0;
    this.status = "idle";
  }
}
