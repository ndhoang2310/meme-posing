export type CameraStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "permission-denied"
  | "no-device"
  | "ended"
  | "insecure-context";

export interface CameraHandle {
  video: HTMLVideoElement;
  stream: MediaStream;
  status: CameraStatus;
  stop: () => void;
}

function errorToStatus(err: unknown): CameraStatus {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission-denied";
  if (
    name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "DevicesNotFoundError"
  )
    return "no-device";
  return "no-device";
}

/**
 * Request the default front camera (prefer 1280x720@30) and attach it to a
 * hidden <video>. Rejects insecure contexts up front since browsers block
 * getUserMedia there.
 */
export async function startCamera(video: HTMLVideoElement): Promise<CameraHandle> {
  if (!window.isSecureContext) {
    throw Object.assign(new Error("insecure context: camera requires HTTPS or localhost"), {
      code: "insecure-context" as CameraStatus,
    });
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error("getUserMedia unavailable"), {
      code: "no-device" as CameraStatus,
    });
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
  } catch (err) {
    throw Object.assign(
      err instanceof Error ? err : new Error("camera request failed"),
      { code: errorToStatus(err) as CameraStatus },
    );
  }

  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  await video.play().catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    if (video.readyState >= 2 && video.videoWidth > 0) {
      resolve();
      return;
    }
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(Object.assign(new Error("video load failed"), { code: "no-device" }));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  stream.getVideoTracks().forEach((track) => {
    track.addEventListener("ended", stop);
  });

  return { video, stream, status: "ready", stop };
}

export function cameraErrorCode(err: unknown): CameraStatus {
  const code = (err as { code?: CameraStatus } | null)?.code;
  if (
    code === "insecure-context" ||
    code === "permission-denied" ||
    code === "no-device" ||
    code === "ended"
  )
    return code;
  if (err instanceof DOMException) return errorToStatus(err);
  return "no-device";
}
