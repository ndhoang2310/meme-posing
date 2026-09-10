import { useCallback, useEffect, useRef, useState } from "react";
import { GAME_CONFIG } from "./game-config";
import type { GameSnapshot, VisionPacket } from "./types";
import { GameEngine } from "../game/GameEngine";
import { loadPoseCatalog } from "../game/poseCatalog";
import { cameraErrorCode, startCamera, type CameraHandle, type CameraStatus } from "../vision/camera";
import { pumpFrame } from "../vision/framePipeline";
import { PoseWorkerClient, type WorkerStatus } from "../vision/poseWorkerClient";
import { fitArena } from "../render/layout";
import { drawSkeleton } from "../render/skeletonCanvas";
import { clearEffects, drawEffects, triggerScoreBurst, triggerWinnerGlow } from "../render/effectsCanvas";
import { CameraArena } from "../components/CameraArena";
import { PlayerPanel } from "../components/PlayerPanel";
import { TargetPoseCard } from "../components/TargetPoseCard";
import { GameHud } from "../components/GameHud";
import { GameOverlay } from "../components/GameOverlay";
import { OperatorControls } from "../components/OperatorControls";
import "../styles/arena.css";
import "../styles/overlays.css";

type AppPhase = "boot" | "camera" | "running" | "fatal";

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
          packetRef.current = p;
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
      const snap = engine.update(packetRef.current, performance.now());
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const halfW = Math.floor(canvas.width / 2);
        ctx.clearRect(0, 0, 0, 0); // noop guard; video already painted by pumpFrame
        drawSkeleton(
          ctx,
          packetRef.current?.left ?? null,
          0,
          halfW,
          canvas.height,
          snap.similarity.left,
          snap.holdMs.left / GAME_CONFIG.holdDurationMs,
        );
        drawSkeleton(
          ctx,
          packetRef.current?.right ?? null,
          halfW,
          canvas.width - halfW,
          canvas.height,
          snap.similarity.right,
          snap.holdMs.right / GAME_CONFIG.holdDurationMs,
        );
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
      setSnapshot(snap);
      const pkt = packetRef.current;
      setPresence((prev) => {
        const next = { left: pkt?.left != null, right: pkt?.right != null };
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
        <PlayerPanel
          side="left"
          score={snapshot.score.left}
          similarity={snapshot.similarity.left}
          detected={presence.left}
          holdProgress={Math.min(1, snapshot.holdMs.left / GAME_CONFIG.holdDurationMs)}
          lastScorer={snapshot.lastScorer}
        />
        <div ref={arenaWrapRef} className="arena-cell">
          {showArena && <CameraArena ref={canvasRef} />}
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
        <PlayerPanel
          side="right"
          score={snapshot.score.right}
          similarity={snapshot.similarity.right}
          detected={presence.right}
          holdProgress={Math.min(1, snapshot.holdMs.right / GAME_CONFIG.holdDurationMs)}
          lastScorer={snapshot.lastScorer}
        />
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
    </div>
  );
}
