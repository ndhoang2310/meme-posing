import type { ReactNode } from "react";
import type { GameState } from "../app/types";
import type { CameraStatus } from "../vision/camera";
import type { WorkerStatus } from "../vision/poseWorkerClient";

interface Props {
  appPhase: "boot" | "camera" | "running" | "fatal";
  cameraStatus: CameraStatus;
  workerStatus: WorkerStatus;
  fatalMessage: string | null;
  gameState: GameState;
  countdownMs: number;
  winner: "left" | "right" | "draw" | null;
  scoreLeft: number;
  scoreRight: number;
  onRetryCamera: () => void;
  children?: ReactNode;
}

export function GameOverlay({
  appPhase,
  cameraStatus,
  workerStatus,
  fatalMessage,
  gameState,
  countdownMs,
  winner,
  scoreLeft,
  scoreRight,
  onRetryCamera,
}: Props) {
  if (appPhase === "fatal") {
    return (
      <div className="overlay" role="alert">
        <div className="overlay-card overlay-error">
          <h2>Không khởi động được game</h2>
          <p>{fatalMessage ?? "Lỗi không xác định."}</p>
          <button className="btn" onClick={() => window.location.reload()}>
            Tải lại
          </button>
        </div>
      </div>
    );
  }

  if (appPhase === "boot") {
    return (
      <div className="overlay">
        <div className="overlay-card">
          <h2>POSE MATCH 1V1</h2>
          <p>Đang tải pose + model nhận diện… ({workerStatus})</p>
          <div className="spinner" />
        </div>
      </div>
    );
  }

  if (appPhase === "camera" || cameraStatus !== "ready") {
    const insecure = cameraStatus === "insecure-context";
    return (
      <div className="overlay">
        <div className="overlay-card">
          <h2>{insecure ? "Cần HTTPS để mở camera" : "Cần quyền camera"}</h2>
          <p>
            {cameraStatus === "permission-denied" &&
              "Browser đã chặn webcam. Hãy bật quyền camera cho domain booth rồi thử lại."}
            {cameraStatus === "no-device" &&
              "Không tìm thấy webcam. Máy booth cần kết nối webcam trước sự kiện."}
            {cameraStatus === "ended" &&
              "Camera đã ngắt (thiết bị bị rút?). Hãy kết nối lại rồi thử lại."}
            {insecure &&
              "Browser chặn webcam ngoài HTTPS/localhost. Hãy host booth qua HTTPS."}
            {cameraStatus === "requesting" && "Đang xin quyền camera…"}
            {cameraStatus === "idle" && "Nhấn Bắt đầu để mở camera booth."}
          </p>
          <button className="btn" onClick={onRetryCamera}>
            {cameraStatus === "idle" ? "Bắt đầu" : "Thử lại camera"}
          </button>
        </div>
      </div>
    );
  }

  if (gameState === "IDLE") {
    return (
      <div className="overlay overlay-passthrough">
        <div className="overlay-banner">2 NGƯỜI CHƠI BƯỚC VÀO KHUNG HÌNH</div>
      </div>
    );
  }
  if (gameState === "COUNTDOWN") {
    const n = Math.max(1, Math.ceil(countdownMs / 1000));
    return (
      <div className="overlay overlay-passthrough">
        <div className="countdown" key={n}>
          {n}
        </div>
      </div>
    );
  }
  if (gameState === "PAUSED") {
    return (
      <div className="overlay overlay-passthrough">
        <div className="overlay-banner">VUI LÒNG TRỞ LẠI VỊ TRÍ</div>
      </div>
    );
  }
  if (gameState === "GAME_OVER") {
    const title =
      winner === "draw" ? "HÒA!" : winner === "left" ? "P1 THẮNG!" : "P2 THẮNG!";
    return (
      <div className="overlay">
        <div className={`overlay-card gameover ${winner ?? "draw"}`}>
          <h2>{title}</h2>
          <div className="final-score">
            {scoreLeft} — {scoreRight}
          </div>
          <p>Trận mới bắt đầu sau 5 giây…</p>
        </div>
      </div>
    );
  }
  return null;
}
