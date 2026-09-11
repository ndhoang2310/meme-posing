import { useCallback, useEffect, useRef, useState } from "react";
import { GAME_CONFIG } from "./game-config";
import type { GameSnapshot, VisionPacket } from "./types";
import { GameEngine } from "../game/GameEngine";
import { loadPoseCatalog } from "../game/poseCatalog";
import { cameraErrorCode, startCamera, type CameraHandle, type CameraStatus } from "../vision/camera";
import { pumpFrame } from "../vision/framePipeline";
import { PoseWorkerClient, type WorkerStatus } from "../vision/poseWorkerClient";
import { fitArena } from "../render/layout";
import { ACCENT_LEFT, ACCENT_RIGHT, drawSkeleton } from "../render/skeletonCanvas";
import { DetectionSmoother } from "../vision/landmarkSmoother";
import { clearEffects, drawEffects, triggerScoreBurst, triggerWinnerGlow } from "../render/effectsCanvas";
import { CameraArena } from "../components/CameraArena";
import { PlayerStatOverlay } from "../components/PlayerStatOverlay";
import { TargetPoseCard } from "../components/TargetPoseCard";
import { GameHud } from "../components/GameHud";
import { GameOverlay } from "../components/GameOverlay";
import { OperatorControls } from "../components/OperatorControls";
import "../styles/arena.css";
import "../styles/overlays.css";

type AppPhase = "boot" | "camera" | "running" | "fatal";

/**
 * Worker liveness window: time since the LAST ARRIVED packet before the
 * worker counts as stalled (frozen / tab jank). Stalled packets are treated
 * as "no players" so the game never scores on frozen landmarks.
 *
 * NOTE: this deliberately measures arrival time, NOT packet timestamp age.
 * Timestamp age includes inference latency, so gating on it misfires on slow
 * CPUs (a healthy-but-slow worker's packets would all look "stale").
 */
const WORKER_ALIVE_MS = 1500;

const initialSnapshot: GameSnapshot = {
  state: "IDLE",
  score: { left: 0, right: 0 },
  currentPose: null,
  roundNumber: 0,
  totalRounds: GAME_CONFIG.totalRounds,
  gameRemainingMs: GAME_CONFIG.gameDurationMs,
  poseRemainingMs: GAME_CONFIG.poseTimeoutMs,
  countdownRemainingMs: GAME_CONFIG.countdownMs,
  holdMs: { left: 0, right: 0 },
  similarity: { left: 0, right: 0 },
  winner: null,
  lastScorer: null,
};

export function App() {
  const [phase, setPhase] = useState<AppPhase>("boot");
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("idle");
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>("idle");
  const [fatalMessage, setFatalMessage] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot>(initialSnapshot);
  const [presence, setPresence] = useState({ left: false, right: false });
  const [opHint, setOpHint] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const arenaWrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const workerRef = useRef<PoseWorkerClient | null>(null);
  const cameraRef = useRef<CameraHandle | null>(null);
  const packetRef = useRef<VisionPacket | null>(null);
  const prevScorerRef = useRef<string | null>(null);
  const prevWinnerRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  // Per-side temporal smoothing (glide + debounce + presence fade).
  const smootherL = useRef(new DetectionSmoother());
  const smootherR = useRef(new DetectionSmoother());
  // Last logic-visible pose per side: drawn dissolving while presence fades.
  const lastPoseL = useRef<VisionPacket["left"]>(null);
  const lastPoseR = useRef<VisionPacket["right"]>(null);
  // Vision telemetry (?debug=1 overlay): arrival liveness + packet counters.
  const packetAtRef = useRef(0);
  const teleRef = useRef({ count: 0, windowStart: 0, fps: 0, rttMs: 0, nullL: 0, nullR: 0 });
  const [debugSnap, setDebugSnap] = useState({ fps: 0, rttMs: 0, nullL: 0, nullR: 0, model: "?" });
  // Dim-layer opacity per half (DOM overlay, GPU-faded). 1 = fully dimmed.
  const [dimLevel, setDimLevel] = useState({ l: 1, r: 1 });
  const debugSentRef = useRef(0);
  // Snapshot throttle: pushing a full React re-render at 60fps janks weak
  // CPUs (canvas + compositor stutter). Discrete changes go instantly;
  // bars/timers ride a 100ms cadence (CSS transitions keep them smooth).
  const uiRef = useRef({ key: "", t: 0 });
  const [showDebug] = useState(
    () => new URLSearchParams(window.location.search).get("debug") === "1",
  );

  const getEngine = () => {
    if (!engineRef.current) engineRef.current = new GameEngine();
    return engineRef.current;
  };

  // Boot: load pose catalog + init pose worker (no camera yet).
  useEffect(() => {
    let cancelled = false;
    let client: PoseWorkerClient | null = null;
    (async () => {
      try {
        const catalog = await loadPoseCatalog();
        if (cancelled) return;
        if (catalog.length === 0) {
          setFatalMessage("Không có pose hợp lệ trong poses_cache.json.");
          setPhase("fatal");
          return;
        }
        getEngine().setCatalog(catalog);
        client = new PoseWorkerClient();
        workerRef.current = client;
        client.onStatus((s, message) => {
          if (cancelled) return;
          setWorkerStatus(s);
          if (s === "error") {
            setFatalMessage(`Không tải được model nhận diện: ${message ?? "unknown"}`);
            setPhase("fatal");
          }
        });
        client.onPacket((p) => {
          const arrived = performance.now();
          packetRef.current = p;
          packetAtRef.current = arrived;
          // Telemetry: detection rate + worker round-trip latency.
          const t = teleRef.current;
          t.count += 1;
          t.rttMs = arrived - p.timestampMs;
          t.nullL = p.left == null ? t.nullL + 1 : 0;
          t.nullR = p.right == null ? t.nullR + 1 : 0;
          if (t.windowStart === 0) t.windowStart = arrived;
        });
        await client.init();
        if (cancelled) return;
        if (!window.isSecureContext) {
          setCameraStatus("insecure-context");
        }
        setPhase("camera");
      } catch (err) {
        if (cancelled) return;
        setFatalMessage(err instanceof Error ? err.message : String(err));
        setPhase("fatal");
      }
    })();
    return () => {
      cancelled = true;
      // StrictMode double-mount: kill the orphaned worker so WASM/model
      // memory isn't held twice. The surviving mount creates its own.
      client?.terminate();
      if (workerRef.current === client) workerRef.current = null;
    };
  }, []);

  const stopLoop = useCallback(() => {
    runningRef.current = false;
  }, []);

  const startLoop = useCallback(() => {
    const canvas = canvasRef.current;
    const video = document.getElementById("booth-video") as HTMLVideoElement | null;
    const engine = getEngine();
    if (!canvas || !video) return;
    const worker = workerRef.current;
    if (!worker) return;
    if (runningRef.current) return;
    runningRef.current = true;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const { backingW, backingH } = fitArena(
        Math.max(320, rect.width),
        Math.max(180, rect.height),
        window.devicePixelRatio || 1,
      );
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
      }
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let prevTs = performance.now();
    const tick = async (ts: number) => {
      if (!runningRef.current) {
        window.removeEventListener("resize", resize);
        return;
      }
      const dt = ts - prevTs;
      prevTs = ts;
      try {
        await pumpFrame(video, canvas, worker);
      } catch {
        // Non-fatal: keep the loop alive on a bad frame.
      }
      const now = performance.now();
      // Worker liveness by ARRIVAL time (see WORKER_ALIVE_MS): a slow-but-alive
      // worker's packets stay valid; only a truly stalled worker goes null.
      const raw = packetRef.current;
      const alive = raw !== null && now - packetAtRef.current <= WORKER_ALIVE_MS;
      const fresh = alive ? raw : null;
      const left = smootherL.current.update(fresh?.left ?? null, now);
      const right = smootherR.current.update(fresh?.right ?? null, now);
      const packet = fresh ? { timestampMs: fresh.timestampMs, left, right } : null;
      // Telemetry: packets/s + per-side consecutive-null streaks.
      const t = teleRef.current;
      if (now - t.windowStart >= 1000 && t.windowStart !== 0) {
        t.fps = (t.count * 1000) / (now - t.windowStart);
        t.count = 0;
        t.windowStart = now;
      }
      if (showDebug && now - debugSentRef.current >= 500) {
        debugSentRef.current = now;
        setDebugSnap({ fps: t.fps, rttMs: t.rttMs, nullL: t.nullL, nullR: t.nullR, model: worker.modelLabel });
      }
      const snap = engine.update(packet, now);
      const ctx = canvas.getContext("2d");
      // NO PLAYER dim is the DEFAULT layer; presence crossfades skeleton in
      // and dim out (and back). Continuous alphas => the layer can never blink.
      const pl = smootherL.current.getPresence();
      const pr = smootherR.current.getPresence();
      if (left) lastPoseL.current = left;
      if (right) lastPoseR.current = right;
      if (ctx) {
        const halfW = Math.floor(canvas.width / 2);
        ctx.clearRect(0, 0, 0, 0); // noop guard; video already painted by pumpFrame
        const showL = left ?? lastPoseL.current;
        const showR = right ?? lastPoseR.current;
        // Canvas draws video + fading skeletons only; the dim is a DOM layer.
        if (showL) drawSkeleton(ctx, showL, 0, halfW, canvas.height, ACCENT_LEFT, pl);
        if (showR) {
          drawSkeleton(ctx, showR, halfW, canvas.width - halfW, canvas.height, ACCENT_RIGHT, pr);
        }
        drawEffects(ctx, canvas.width, canvas.height, ts, Math.min(dt, 100));
      }
      // Score / winner transitions -> effects (edge-triggered).
      const scorerKey = snap.lastScorer ? `${snap.lastScorer}-${snap.score[snap.lastScorer]}` : null;
      if (scorerKey && scorerKey !== prevScorerRef.current && snap.state === "PLAYING") {
        if (snap.lastScorer) triggerScoreBurst(snap.lastScorer);
      }
      prevScorerRef.current = snap.state === "PLAYING" ? scorerKey : null;
      if (snap.state === "GAME_OVER" && prevWinnerRef.current !== "done") {
        prevWinnerRef.current = "done";
        triggerWinnerGlow();
      } else if (snap.state !== "GAME_OVER") {
        prevWinnerRef.current = null;
      }
      // Throttled UI push (see uiRef): full 60fps re-renders are skipped.
      const uiKey =
        `${snap.state}|${snap.score.left}|${snap.score.right}|${snap.roundNumber}|` +
        `${snap.winner}|${snap.lastScorer}|${Math.ceil(snap.countdownRemainingMs / 250)}|` +
        `${Math.ceil(snap.gameRemainingMs / 1000)}`;
      const ui = uiRef.current;
      if (uiKey !== ui.key || now - ui.t >= 100) {
        ui.key = uiKey;
        ui.t = now;
        setSnapshot(snap);
        // DOM dim layers ride the same ~10Hz push; CSS transition smooths it.
        setDimLevel((prev) => {
          const next = { l: 1 - pl, r: 1 - pr };
          return prev.l === next.l && prev.r === next.r ? prev : next;
        });
      }
      // Panels follow the slow presence level (free hysteresis for UI text).
      setPresence((prev) => {
        const next = { left: pl >= 0.5, right: pr >= 0.5 };
        return prev.left === next.left && prev.right === next.right ? prev : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    void raf;
  }, []);

  const handleStartCamera = useCallback(async () => {
    const video = document.getElementById("booth-video") as HTMLVideoElement | null;
    if (!video) return;
    setCameraStatus("requesting");
    try {
      const handle = await startCamera(video);
      cameraRef.current = handle;
      handle.stream.getVideoTracks().forEach((t) =>
        t.addEventListener("ended", () => {
          setCameraStatus("ended");
          stopLoop();
          setPhase("camera");
        }),
      );
      setCameraStatus("ready");
      setPhase("running");
      startLoop();
    } catch (err) {
      setCameraStatus(cameraErrorCode(err));
    }
  }, [startLoop, stopLoop]);

  const handleReset = useCallback(() => {
    getEngine().resetToIdle();
    packetRef.current = null;
    smootherL.current.reset();
    smootherR.current.reset();
    lastPoseL.current = null;
    lastPoseR.current = null;
    setDimLevel({ l: 1, r: 1 });
    clearEffects();
    prevScorerRef.current = null;
    prevWinnerRef.current = null;
    setSnapshot(getEngine().snapshot());
  }, []);

  const handleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
      setOpHint(null);
    } catch {
      setOpHint("Browser từ chối fullscreen — vẫn chơi ở chế độ cửa sổ.");
      window.setTimeout(() => setOpHint(null), 3000);
    }
  }, []);

  // Tab hidden: drop stale detections so the game never resumes on old landmarks.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) getEngine().resetDetectionStability();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Cleanup on unmount: stop camera, terminate worker, cancel loop.
  useEffect(() => {
    return () => {
      runningRef.current = false;
      cameraRef.current?.stop();
      workerRef.current?.terminate();
    };
  }, []);

  const showArena = phase === "running" || phase === "camera";

  return (
    <div className="booth">
      <GameHud
        scoreLeft={snapshot.score.left}
        scoreRight={snapshot.score.right}
        gameRemainingMs={snapshot.gameRemainingMs}
        poseRemainingMs={snapshot.poseRemainingMs}
        roundNumber={snapshot.roundNumber}
        totalRounds={snapshot.totalRounds}
      />
      <div className="main-row">
        <div ref={arenaWrapRef} className="arena-cell">
          {showArena && <CameraArena ref={canvasRef} />}
          {showArena && (
            <>
              <div className="dim-layer dim-left" style={{ opacity: dimLevel.l }}>
                <span className="dim-text">NO PLAYER</span>
              </div>
              <div className="dim-layer dim-right" style={{ opacity: dimLevel.r }}>
                <span className="dim-text">NO PLAYER</span>
              </div>
            </>
          )}
          {showArena && (
            <>
              <PlayerStatOverlay
                side="left"
                score={snapshot.score.left}
                similarity={snapshot.similarity.left}
                detected={presence.left}
                holdProgress={Math.min(1, snapshot.holdMs.left / GAME_CONFIG.holdDurationMs)}
              />
              <PlayerStatOverlay
                side="right"
                score={snapshot.score.right}
                similarity={snapshot.similarity.right}
                detected={presence.right}
                holdProgress={Math.min(1, snapshot.holdMs.right / GAME_CONFIG.holdDurationMs)}
              />
            </>
          )}
          {(snapshot.state === "PLAYING" || snapshot.state === "PAUSED") && (
            <div className="target-overlay">
              <TargetPoseCard
                pose={snapshot.currentPose}
                roundNumber={snapshot.roundNumber}
                totalRounds={snapshot.totalRounds}
              />
            </div>
          )}
        </div>
      </div>
      <footer className="footer">
        <span className="status-line">
          {phase === "running"
            ? snapshot.state === "PLAYING"
              ? "Cùng bắt chước pose ở giữa!"
              : snapshot.state
            : `camera: ${cameraStatus} · model: ${workerStatus}`}
        </span>
        <OperatorControls onReset={handleReset} onFullscreen={handleFullscreen} hint={opHint} />
      </footer>
      {(phase !== "running" || snapshot.state !== "PLAYING") && (
        <GameOverlay
          appPhase={phase}
          cameraStatus={cameraStatus}
          workerStatus={workerStatus}
          fatalMessage={fatalMessage}
          gameState={snapshot.state}
          countdownMs={snapshot.countdownRemainingMs}
          winner={snapshot.winner}
          scoreLeft={snapshot.score.left}
          scoreRight={snapshot.score.right}
          onRetryCamera={handleStartCamera}
        />
      )}
      {showDebug && (
        <div
          style={{
            position: "fixed",
            left: 8,
            bottom: 8,
            zIndex: 99,
            background: "rgba(0,0,0,0.75)",
            color: "#7dffb0",
            font: "12px monospace",
            padding: "6px 10px",
            borderRadius: 6,
            pointerEvents: "none",
          }}
        >
          det {debugSnap.fps.toFixed(1)}/s · rtt {Math.round(debugSnap.rttMs)}ms · nullL
          x{debugSnap.nullL} · nullR x{debugSnap.nullR} · {debugSnap.model}
        </div>
      )}
    </div>
  );
}
