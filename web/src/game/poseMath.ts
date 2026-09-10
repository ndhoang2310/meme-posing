import type { Landmark } from "../app/types";

/**
 * Port of src/pose_math.py (UPPER_BODY_ONLY=true).
 * Only the 4 upper-body angles are used for scoring:
 *   left elbow:   angle(11, 13, 15)
 *   right elbow:  angle(12, 14, 16)
 *   left shoulder:angle(23, 11, 13)
 *   right shoulder:angle(24, 12, 14)
 */

type Point2D = { x: number; y: number };

function toPoint(lm: Landmark | { x: number; y: number } | [number, number]): Point2D {
  if (Array.isArray(lm)) return { x: lm[0], y: lm[1] };
  return { x: lm.x, y: lm.y };
}

/** Angle at vertex B formed by A-B-C, in degrees 0..180. */
export function calculateAngle(
  a: Landmark | { x: number; y: number } | [number, number],
  b: Landmark | { x: number; y: number } | [number, number],
  c: Landmark | { x: number; y: number } | [number, number],
): number {
  const pa = toPoint(a);
  const pb = toPoint(b);
  const pc = toPoint(c);
  const radians =
    Math.atan2(pc.y - pb.y, pc.x - pb.x) -
    Math.atan2(pa.y - pb.y, pa.x - pb.x);
  let angle = Math.abs((radians * 180) / Math.PI);
  if (angle > 180) angle = 360 - angle;
  return angle;
}

const REQUIRED_INDICES = [11, 12, 13, 14, 15, 16, 23, 24];

function hasJoints(landmarks: Landmark[] | null | undefined): boolean {
  if (!landmarks || landmarks.length < 29) return false;
  return REQUIRED_INDICES.every((i) => {
    const lm = landmarks[i];
    return (
      lm != null &&
      Number.isFinite(lm.x) &&
      Number.isFinite(lm.y)
    );
  });
}

/**
 * Extract the 4 scoring angles. Returns null when landmarks are
 * missing/invalid instead of throwing.
 */
export function jointAngles(
  landmarks: Landmark[] | null | undefined,
): [number, number, number, number] | null {
  if (!hasJoints(landmarks)) return null;
  const lms = landmarks as Landmark[];
  const theta1 = calculateAngle(lms[11], lms[13], lms[15]);
  const theta2 = calculateAngle(lms[12], lms[14], lms[16]);
  const theta3 = calculateAngle(lms[23], lms[11], lms[13]);
  const theta4 = calculateAngle(lms[24], lms[12], lms[14]);
  return [theta1, theta2, theta3, theta4];
}

/**
 * Discriminative 0..1 score (port of pose_match_similarity with the
 * production tolerance: 60deg ramp => jointScore = clamp(1 - err/60)).
 * Returns 0 for mismatched/empty vectors — never throws.
 */
export function poseMatchSimilarity(
  playerAngles: number[] | null | undefined,
  targetAngles: number[] | null | undefined,
): number {
  if (!playerAngles || !targetAngles) return 0;
  if (playerAngles.length === 0 || playerAngles.length !== targetAngles.length)
    return 0;
  let sum = 0;
  for (let i = 0; i < playerAngles.length; i++) {
    const a = playerAngles[i];
    const b = targetAngles[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    const err = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    sum += Math.max(0, Math.min(1, 1 - err / 60));
  }
  return sum / playerAngles.length;
}

export function isPoseMatch(
  playerAngles: number[] | null | undefined,
  targetAngles: number[] | null | undefined,
  threshold = 0.8,
): { match: boolean; similarity: number } {
  const similarity = poseMatchSimilarity(playerAngles, targetAngles);
  return { match: similarity >= threshold, similarity };
}
