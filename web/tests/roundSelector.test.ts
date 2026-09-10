import { describe, expect, it } from "vitest";
import { buildRoundOrder, resolveRounds } from "../src/game/roundSelector";

function sequenceRand(seq: number[]): () => number {
  let i = 0;
  return () => seq[(i++) % seq.length];
}

describe("buildRoundOrder", () => {
  it("produces exactly 9 rounds", () => {
    const order = buildRoundOrder(30, 9);
    expect(order).toHaveLength(9);
  });
  it("avoids a boundary repeat between cycles when avoidable", () => {
    // 2 poses, 4 rounds: cycles of [0,1] shuffled; check no equal adjacents.
    for (let attempt = 0; attempt < 50; attempt++) {
      const order = buildRoundOrder(2, 4);
      for (let i = 1; i < order.length; i++) {
        expect(order[i]).not.toBe(order[i - 1]);
      }
    }
  });
  it("supports fewer poses than rounds by cycling", () => {
    const order = buildRoundOrder(3, 9);
    expect(order).toHaveLength(9);
    expect(new Set(order).size).toBe(3);
  });
  it("returns [] for empty catalog", () => {
    expect(buildRoundOrder(0, 9)).toEqual([]);
  });
  it("is deterministic with an injected RNG", () => {
    const a = buildRoundOrder(5, 9, sequenceRand([0.1, 0.9, 0.3, 0.7, 0.5]));
    const b = buildRoundOrder(5, 9, sequenceRand([0.1, 0.9, 0.3, 0.7, 0.5]));
    expect(a).toEqual(b);
  });
});

describe("resolveRounds", () => {
  it("maps indices to pose definitions, dropping out-of-range", () => {
    const catalog = [
      { id: "a", imageUrl: "/poses/a.jpg", targetVector: [1, 2, 3, 4] as [number, number, number, number] },
      { id: "b", imageUrl: "/poses/b.jpg", targetVector: [5, 6, 7, 8] as [number, number, number, number] },
    ];
    expect(resolveRounds(catalog, [1, 0, 99])).toEqual([catalog[1], catalog[0]]);
  });
});
