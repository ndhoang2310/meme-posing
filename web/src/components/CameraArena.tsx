import { forwardRef } from "react";

interface Props {
  onFirstFrame?: () => void;
}

/**
 * Owns the hidden <video> + full-size display canvas.
 * The parent drives per-frame drawing; this just provides the elements.
 */
export const CameraArena = forwardRef<HTMLCanvasElement, Props>(function CameraArena(
  { onFirstFrame: _onFirstFrame },
  canvasRef,
) {
  return (
    <div className="arena-wrap">
      <video id="booth-video" muted playsInline autoPlay style={{ display: "none" }} />
      <canvas ref={canvasRef} className="arena-canvas" />
      <div className="arena-divider" />
    </div>
  );
});
