import type { PoseDefinition } from "../app/types";

interface RawPoseEntry {
  image_path?: string;
  target_vector?: unknown;
  difficulty?: string;
}

interface RawCache {
  poses?: Record<string, RawPoseEntry>;
}

function isValidVector(v: unknown): v is [number, number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/** Map legacy asset paths ("assets/poses/x.jpg") to public URLs ("/poses/x.jpg"). */
export function toPublicPoseUrl(imagePath: string): string {
  const file = imagePath.split("/").pop() ?? imagePath;
  return `/poses/${encodeURIComponent(file)}`;
}

/** Fetch + validate /poses_cache.json. Invalid poses are dropped. */
export async function loadPoseCatalog(
  url = "/poses_cache.json",
  fetchFn: typeof fetch = fetch,
): Promise<PoseDefinition[]> {
  // no-store: boot must never run on a stale cached catalog.
  const res = await fetchFn(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`pose catalog fetch failed: ${res.status}`);
  const raw = (await res.json()) as RawCache | Record<string, RawPoseEntry>;
  const dict: Record<string, RawPoseEntry> =
    raw && typeof raw === "object" && "poses" in raw && (raw as RawCache).poses
      ? ((raw as RawCache).poses as Record<string, RawPoseEntry>)
      : (raw as Record<string, RawPoseEntry>);

  const catalog: PoseDefinition[] = [];
  for (const [id, entry] of Object.entries(dict ?? {})) {
    if (!entry || typeof entry.image_path !== "string" || !entry.image_path) continue;
    if (!isValidVector(entry.target_vector)) continue;
    catalog.push({
      id,
      imageUrl: toPublicPoseUrl(entry.image_path),
      targetVector: entry.target_vector,
      difficulty: typeof entry.difficulty === "string" ? entry.difficulty : undefined,
    });
  }
  // Stable order by id so round shuffles are reproducible per load.
  catalog.sort((a, b) => a.id.localeCompare(b.id));
  return catalog;
}
