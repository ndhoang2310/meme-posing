import { describe, expect, it } from "vitest";
import { loadPoseCatalog, toPublicPoseUrl } from "../src/game/poseCatalog";

describe("toPublicPoseUrl", () => {
  it("maps legacy asset paths to /poses URLs", () => {
    expect(toPublicPoseUrl("assets/poses/pose_1.jpeg")).toBe("/poses/pose_1.jpeg");
    expect(toPublicPoseUrl("assets/poses/pose 21.jpg")).toBe("/poses/pose%2021.jpg");
  });
});

describe("loadPoseCatalog", () => {
  const fakeFetch = (body: unknown, ok = true) =>
    (async () =>
      ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response) as typeof fetch;

  it("loads valid poses and drops invalid ones", async () => {
    const catalog = await loadPoseCatalog(
      "/poses_cache.json",
      fakeFetch({
        poses: {
          good: { image_path: "assets/poses/a.jpg", target_vector: [1, 2, 3, 4] },
          badVec: { image_path: "assets/poses/b.jpg", target_vector: [1, 2] },
          noImg: { target_vector: [1, 2, 3, 4] },
        },
      }),
    );
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe("good");
    expect(catalog[0].imageUrl).toBe("/poses/a.jpg");
  });

  it("throws on fetch failure", async () => {
    await expect(loadPoseCatalog("/x", fakeFetch({}, false))).rejects.toThrow();
  });
});
