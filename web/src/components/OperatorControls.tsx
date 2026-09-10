import { useEffect } from "react";

interface Props {
  onReset: () => void;
  onFullscreen: () => void;
  hint: string | null;
}

export function OperatorControls({ onReset, onFullscreen, hint }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "r" || e.key === "R") onReset();
      if (e.key === "f" || e.key === "F") onFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onReset, onFullscreen]);

  return (
    <div className="operator" aria-label="Operator controls">
      <span className="op-hint">{hint ?? "R: reset · F: fullscreen"}</span>
      <button className="btn btn-ghost" onClick={onReset}>
        Reset (R)
      </button>
      <button className="btn btn-ghost" onClick={onFullscreen}>
        Fullscreen (F)
      </button>
    </div>
  );
}
