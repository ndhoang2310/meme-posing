import { describe, expect, it } from "vitest";
import { skeletonColor } from "../src/render/skeletonCanvas";

describe("skeletonColor", () => {
  it("is white below 72%, yellow below 88%, green above", () => {
    expect(skeletonColor(0.5)).toBe("#ffffff");
    expect(skeletonColor(0.8)).toBe("#ffd23f");
    expect(skeletonColor(0.9)).toBe("#39ff6a");
  });
});
