/** 16:9 booth layout helpers for the arena canvas. */
export interface ArenaLayout {
  canvasW: number;
  canvasH: number;
  dividerX: number;
}

/** Size the display canvas to its container while keeping 16:9. */
export function fitArena(
  containerW: number,
  containerH: number,
  dpr = 1,
): { cssW: number; cssH: number; backingW: number; backingH: number } {
  const targetRatio = 16 / 9;
  let cssW = containerW;
  let cssH = containerW / targetRatio;
  if (cssH > containerH) {
    cssH = containerH;
    cssW = containerH * targetRatio;
  }
  const scale = Math.min(dpr, 2);
  return {
    cssW: Math.floor(cssW),
    cssH: Math.floor(cssH),
    backingW: Math.floor(cssW * scale),
    backingH: Math.floor(cssH * scale),
  };
}

export function arenaLayout(canvasW: number, canvasH: number): ArenaLayout {
  return { canvasW, canvasH, dividerX: Math.floor(canvasW / 2) };
}
