/**
 * Asymmetric detection scheduling for the split-frame worker.
 *
 * Observation: a half-frame WITH a tracked player is cheap (MediaPipe VIDEO
 * tracking), while an EMPTY half pays a full detection search every packet.
 * With P1 present + P2 absent, the empty half steals most of the CPU and the
 * tracked side updates slowly ("delay" + flicker for P1).
 *
 * Policy: a side that keeps returning null goes sparse — detected 1 in
 * SPARSE_EVERY packets (phases staggered so the two halves never collide).
 * The first detection switches it back to full rate immediately, so a player
 * stepping in is picked up within a few packets.
 */
export const IDLE_AFTER_NULLS = 5;
export const SPARSE_EVERY = 4;
export const SPARSE_PHASE_LEFT = 0;
export const SPARSE_PHASE_RIGHT = 2;

/** Consecutive null-packet count -> should this half run inference now? */
export function shouldRunHalf(nullRun: number, seq: number, phase: number): boolean {
  if (nullRun <= IDLE_AFTER_NULLS) return true;
  return seq % SPARSE_EVERY === phase;
}
