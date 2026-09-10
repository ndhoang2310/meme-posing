import type { PoseDefinition } from "../app/types";

/**
 * Build a 9-round order from pose indices.
 * Shuffle the full catalog; if more rounds are needed, append another
 * shuffle. The first pose of a new cycle never repeats the last pose of
 * the previous cycle when there is more than one pose.
 */
export function buildRoundOrder(
  poseCount: number,
  totalRounds: number,
  rand: () => number = Math.random,
): number[] {
  if (poseCount <= 0 || totalRounds <= 0) return [];
  const order: number[] = [];
  while (order.length < totalRounds) {
    const cycle = Array.from({ length: poseCount }, (_, i) => i);
    // Fisher-Yates with injected RNG for tests.
    for (let i = cycle.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [cycle[i], cycle[j]] = [cycle[j], cycle[i]];
    }
    if (order.length > 0 && cycle.length > 1 && cycle[0] === order[order.length - 1]) {
      [cycle[0], cycle[1]] = [cycle[1], cycle[0]];
    }
    order.push(...cycle);
  }
  return order.slice(0, totalRounds);
}

/** Resolve a round order of indices into pose definitions. */
export function resolveRounds(
  catalog: PoseDefinition[],
  order: number[],
): PoseDefinition[] {
  return order
    .filter((i) => i >= 0 && i < catalog.length)
    .map((i) => catalog[i]);
}
