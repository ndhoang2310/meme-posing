/** Full-screen neon flash / particle effects drawn above video+skeleton. */

interface Particle {
  x: number; // 0..1 normalized
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}

const particles: Particle[] = [];
let flashUntil = 0;
let flashColor = "#ffffff";

export function triggerScoreBurst(side: "left" | "right"): void {
  flashUntil = performance.now() + 350;
  flashColor = side === "left" ? "#00e5ff" : "#ff2d78";
  const baseX = side === "left" ? 0.25 : 0.75;
  for (let i = 0; i < 60; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.15 + Math.random() * 0.5;
    particles.push({
      x: baseX + (Math.random() - 0.5) * 0.1,
      y: 0.4 + (Math.random() - 0.5) * 0.2,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 0.25,
      life: 0,
      maxLife: 600 + Math.random() * 600,
      color: side === "left" ? "#00e5ff" : "#ff2d78",
    });
  }
}

export function triggerWinnerGlow(): void {
  flashUntil = performance.now() + 1200;
  flashColor = "#ffd23f";
}

export function drawEffects(ctx: CanvasRenderingContext2D, w: number, h: number, now: number, dt: number): void {
  // Score flash vignette.
  if (now < flashUntil) {
    const alpha = 0.25 * ((flashUntil - now) / 350);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(0.3, alpha));
    ctx.strokeStyle = flashColor;
    ctx.lineWidth = 24;
    ctx.shadowColor = flashColor;
    ctx.shadowBlur = 40;
    ctx.strokeRect(4, 4, w - 8, h - 8);
    ctx.restore();
  }
  // Particles.
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life >= p.maxLife) {
      particles.splice(i, 1);
      continue;
    }
    p.x += (p.vx * dt) / 1000;
    p.y += (p.vy * dt) / 1000;
    p.vy += (0.6 * dt) / 1000;
    const t = 1 - p.life / p.maxLife;
    ctx.save();
    ctx.globalAlpha = t;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 10;
    ctx.fillRect(p.x * w, p.y * h, 5, 5);
    ctx.restore();
  }
}

export function clearEffects(): void {
  particles.length = 0;
  flashUntil = 0;
}
