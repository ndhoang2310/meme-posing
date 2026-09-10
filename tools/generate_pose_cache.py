#!/usr/bin/env python3
"""Generate data/poses_cache.json from images in assets/poses/.

Scans the poses folder for any image (png/jpeg/jpg/webp/bmp/gif/...), runs
MediaPipe pose detection on each one, computes the same joint-angle target_vector
the game uses (src/pose_math.joint_angles), and writes data/poses_cache.json.

Usage:
    ./venv/bin/python tools/generate_pose_cache.py                      # scan + update
    ./venv/bin/python tools/generate_pose_cache.py --dry-run            # only print what would change
    ./venv/bin/python tools/generate_pose_cache.py --difficulty easy    # force difficulty on new poses

Existing entries are kept (same image_path -> same difficulty/target) unless the
image changes or --force is passed.
"""

import argparse
import json
import os
import sys

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import cv2
import numpy as np

from src.pose_math import joint_angles
from src.config import UPPER_BODY_ONLY, UPPER_BODY_LANDMARKS

IMAGE_EXTS = {".png", ".jpeg", ".jpg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}

# Same skeleton as the game's renderer (src/renderer._draw_skeleton).
if UPPER_BODY_ONLY:
    SKELETON_CONNECTIONS = [
        (11, 13), (13, 15),
        (12, 14), (14, 16),
        (11, 23), (12, 24),
        (23, 24),
        (11, 12),
    ]
else:
    SKELETON_CONNECTIONS = [
        (11, 13), (13, 15),
        (12, 14), (14, 16),
        (11, 23), (23, 25), (25, 27),
        (12, 24), (24, 26), (26, 28),
        (23, 24),
        (11, 12),
    ]

# Rough neutral standing pose (degrees) used to auto-classify difficulty.
# Full-stretch joints -> easy to hold; extreme bending -> harder.
# Upper-body only (elbow L/R, shoulder L/R) to match src/pose_math with UPPER_BODY_ONLY.
_NEUTRAL = [170, 170, 175, 175]


def mediapipe_pose():
    """Build a pose detector (legacy solutions API - robust, no .task file needed)."""
    import mediapipe as mp
    return mp.solutions.pose.Pose(
        static_image_mode=True,
        model_complexity=1,
        min_detection_confidence=0.4,
        min_tracking_confidence=0.4,
    )


def detect_landmarks(image_path, detector):
    """Return list of 33 (x, y) pixel tuples or None if no person detected."""
    frame = cv2.imread(image_path)
    if frame is None:
        return None
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = detector.process(rgb)
    if not results.pose_landmarks:
        return None
    h, w = frame.shape[:2]
    return [(lm.x * w, lm.y * h) for lm in results.pose_landmarks.landmark]


def detect_landmarks_frame(frame, detector):
    """Detect pose landmarks from an already-read BGR frame."""
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = detector.process(rgb)
    if not results.pose_landmarks:
        return None
    h, w = frame.shape[:2]
    return [(lm.x * w, lm.y * h) for lm in results.pose_landmarks.landmark]


def draw_pose(img, landmarks_px, color=(0, 229, 255), thickness=3):
    """Draw upper-body skeleton + bbox on an image in pixel coordinates."""
    pts = {}
    for idx in range(33):
        if idx < len(landmarks_px):
            pts[idx] = (int(round(landmarks_px[idx][0])), int(round(landmarks_px[idx][1])))

    for a, b in SKELETON_CONNECTIONS:
        if a in pts and b in pts:
            cv2.line(img, pts[a], pts[b], color, thickness)

    if UPPER_BODY_ONLY:
        box_pts = [pts[i] for i in UPPER_BODY_LANDMARKS if i in pts]
    else:
        box_pts = list(pts.values())
    if box_pts:
        xs = [p[0] for p in box_pts]
        ys = [p[1] for p in box_pts]
        cv2.rectangle(img, (min(xs), min(ys)), (max(xs), max(ys)), (255, 213, 0), 2)

    for idx, p in pts.items():
        cv2.circle(img, p, 4, color, -1)
        cv2.circle(img, p, 2, (4, 6, 18), -1)

    return img


def classify_difficulty(angles):
    """Heuristic difficulty: how far the pose deviates from a neutral stance."""
    deviation = sum(abs(a - n) for a, n in zip(angles, _NEUTRAL)) / len(angles)
    if deviation < 60:
        return "easy"
    elif deviation < 95:
        return "medium"
    return "hard"


def load_existing(cache_path):
    if not os.path.exists(cache_path):
        return {}
    with open(cache_path, "r") as f:
        data = json.load(f)
    poses = data.get("poses", {})
    if isinstance(poses, dict):
        return poses
    # Backward compat: list of poses
    return {f"pose_{i + 1}": p for i, p in enumerate(poses)}


def scan_pose_images(poses_dir):
    if not os.path.isdir(poses_dir):
        return []
    files = []
    for name in sorted(os.listdir(poses_dir)):
        ext = os.path.splitext(name)[1].lower()
        if ext in IMAGE_EXTS:
            files.append(os.path.join(poses_dir, name))
    return files


def relative_path(root, full):
    return os.path.relpath(full, root).replace("\\", "/")


def detect_all(images, detector):
    """Return list of (image_path, landmarks) with detection results."""
    results = []
    for img in images:
        lms = detect_landmarks(img, detector)
        if lms is None:
            print(f"  ! no person detected: {os.path.basename(img)}")
        else:
            print(f"  ? detected: {os.path.basename(img)}")
        results.append((img, lms))
    return results


def build_cache(images, detected, existing, force=False, difficulty=None, annotate_dir=None):
    """Build new poses dict preserving existing entries where possible."""
    existing_by_path = {p.get("image_path"): p for p in existing.values()}
    new_poses = {}
    for i, (img_path, lms) in enumerate(detected):
        key = f"pose_{i + 1}"
        rel = relative_path(PROJECT_ROOT, img_path)
        if lms is None:
            continue
        # Same computation as the game (src/pose_math.joint_angles) - single source of truth.
        angles = joint_angles(lms)

        if annotate_dir and lms is not None:
            os.makedirs(annotate_dir, exist_ok=True)
            img = cv2.imread(img_path)
            if img is not None:
                draw_pose(img, lms)
                name = os.path.splitext(os.path.basename(img_path))[0]
                cv2.imwrite(os.path.join(annotate_dir, f"{name}_pose.png"), img)

        prev = existing_by_path.get(rel)
        if prev and not force:
            # Keep existing target_vector only if image unchanged? We can't easily
            # hash here cheaply; assume changed file -> recompute angles but keep
            # difficulty unless explicitly overridden.
            chosen_diff = difficulty or prev.get("difficulty", classify_difficulty(angles))
            entry = dict(prev)
            entry["image_path"] = rel
            entry["target_vector"] = [round(v, 3) for v in angles]
            entry["difficulty"] = chosen_diff
        else:
            chosen_diff = difficulty or classify_difficulty(angles)
            entry = {
                "image_path": rel,
                "target_vector": [round(v, 3) for v in angles],
                "difficulty": chosen_diff,
            }
        new_poses[key] = entry
    return new_poses


def build_capture_canvas(frame, ref, count, idx, total):
    """Combine live camera feed + reference image + countdown text into one canvas."""
    disp = cv2.resize(frame, (640, 360))
    # Pad reference image to same height
    if ref is not None:
        rh = 360
        rw = int(ref.shape[1] * (rh / ref.shape[0]))
        ref_s = cv2.resize(ref, (rw, rh))
    else:
        ref_s = np.full((360, 400, 3), (16, 20, 44), dtype=np.uint8)

    gap = 20
    canvas = np.full((360, disp.shape[1] + gap + ref_s.shape[1], 3),
                     (10, 12, 30), dtype=np.uint8)
    canvas[:, :disp.shape[1]] = disp
    canvas[:, disp.shape[1] + gap:] = ref_s

    # Header text
    cv2.putText(canvas, f"RECORD POSE {idx}/{total}", (10, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 213, 0), 2)
    # Countdown / capture text
    if count == 0:
        txt, color = "CAPTURE!", (57, 255, 20)
    else:
        txt, color = str(count), (240, 245, 255)
    cv2.putText(canvas, txt, (10, 90),
                cv2.FONT_HERSHEY_SIMPLEX, 2.0, color, 4)
    cv2.putText(canvas, "Strike the pose!", (10, 130),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (160, 172, 200), 2)
    cv2.putText(canvas, "ESC = quit", (10, 350),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (160, 172, 200), 1)
    return canvas


def record_live(images, detector, cache_path, camera_index=0, difficulty=None,
                countdown=3):
    """Record pose target_vectors from the live camera.

    Shows each reference image, runs a countdown, then captures the pose the
    operator is holding at the moment the countdown ends and computes its
    target_vector (same joint_angles as the game).
    """
    import time
    cap = cv2.VideoCapture(camera_index)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    if not cap.isOpened():
        print(f"Cannot open camera {camera_index}")
        return {}

    win = "RECORD POSES"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    poses = {}
    n = len(images)
    try:
        for i, img_path in enumerate(images):
            ref = cv2.imread(img_path) if img_path and os.path.exists(img_path) else None
            key = f"pose_{i + 1}"
            rel = relative_path(PROJECT_ROOT, img_path) if img_path else ""

            captured = None
            start = time.time()
            done = False
            while not done:
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.03)
                    continue
                frame = cv2.flip(frame, 1)
                elapsed = time.time() - start
                if elapsed >= countdown:
                    # Capture the pose at the moment the countdown ends
                    captured = frame.copy()
                    count = 0
                    done = True
                else:
                    count = max(0, countdown - int(elapsed))

                canvas = build_capture_canvas(frame, ref, count, i + 1, n)
                cv2.imshow(win, canvas)
                k = cv2.waitKey(1) & 0xFF
                if k in (27, ord('q')):
                    print("Recording aborted.")
                    return {}
                # Cap loop to ~30 FPS (cap.read() usually already blocks)
                time.sleep(0.02)

            if captured is None:
                print(f"  ! no frame captured for {key}")
                continue

            lms = detect_landmarks_frame(captured, detector)
            if lms is None:
                print(f"  ! no pose detected in captured frame for {key}")
                continue
            angles = joint_angles(lms)
            chosen_diff = difficulty or classify_difficulty(angles)
            poses[key] = {
                "image_path": rel,
                "target_vector": [round(v, 3) for v in angles],
                "difficulty": chosen_diff,
            }
            print(f"  ? captured {key}: target={[round(v) for v in angles]}")
    finally:
        cap.release()
        cv2.destroyAllWindows()

    return poses


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--poses-dir", default=os.path.join(PROJECT_ROOT, "assets", "poses"),
                        help="Folder with pose/meme images")
    parser.add_argument("--cache", default=os.path.join(PROJECT_ROOT, "data", "poses_cache.json"),
                        help="Output poses_cache.json path")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would change without writing")
    parser.add_argument("--force", action="store_true",
                        help="Recompute everything, keep difficulty for unchanged images")
    parser.add_argument("--difficulty", choices=["easy", "medium", "hard"], default=None,
                        help="Force difficulty for newly added poses")
    parser.add_argument("--annotate", action="store_true",
                        help="Save an annotated preview (skeleton + bbox) per pose image")
    parser.add_argument("--annotate-dir", default=os.path.join(PROJECT_ROOT, "assets", "poses_annotated"),
                        help="Folder for annotated previews (used with --annotate)")
    parser.add_argument("--live", action="store_true",
                        help="Record pose targets from the live camera (countdown + capture)")
    parser.add_argument("--camera", type=int, default=0, help="Camera index (used with --live)")
    parser.add_argument("--countdown", type=int, default=3,
                        help="Countdown seconds before each capture (used with --live)")
    args = parser.parse_args()

    if args.live:
        images = scan_pose_images(args.poses_dir)
        if not images:
            print(f"No pose images found in {args.poses_dir}")
            print("Add reference pose images (png/jpeg/jpg/webp/bmp/gif) to show during recording.")
            return 1
        print(f"Recording {len(images)} pose(s) from camera {args.camera}...")
        print(f"UPPER_BODY_ONLY={UPPER_BODY_ONLY} -> target_vector dim = "
              f"{len(joint_angles([(0, 0)] * 33))} (same as game)")
        detector = mediapipe_pose()
        try:
            new_poses = record_live(images, detector, args.cache,
                                    camera_index=args.camera,
                                    difficulty=args.difficulty,
                                    countdown=args.countdown)
        finally:
            detector.close()
        if not new_poses:
            print("No poses recorded.")
            return 1
        print(f"\nResult: {len(new_poses)} pose(s) recorded")
        for key, p in new_poses.items():
            print(f"  {key}: {p['image_path']}  [{p['difficulty']}]  "
                  f"target={[round(v) for v in p['target_vector']]}")
        os.makedirs(os.path.dirname(args.cache), exist_ok=True)
        with open(args.cache, "w") as f:
            json.dump({"poses": new_poses}, f, indent=2)
        print(f"\nWrote {args.cache}")
        return 0

    images = scan_pose_images(args.poses_dir)
    if not images:
        print(f"No images found in {args.poses_dir}")
        print(f"Put pose/meme images here (png/jpeg/jpg/webp/bmp/gif).")
        return 1

    print(f"Scanning {len(images)} image(s) in {args.poses_dir}")
    print(f"UPPER_BODY_ONLY={UPPER_BODY_ONLY} -> target_vector dim = "
          f"{len(joint_angles([(0,0)]*33))} (same as game)")
    detector = mediapipe_pose()
    try:
        detected = detect_all(images, detector)
    finally:
        detector.close()

    existing = load_existing(args.cache)
    annotate_dir = args.annotate_dir if args.annotate else None
    new_poses = build_cache(images, detected, existing, force=args.force,
                            difficulty=args.difficulty, annotate_dir=annotate_dir)

    print(f"\nResult: {len(new_poses)} pose(s) ready")
    for key, p in new_poses.items():
        print(f"  {key}: {p['image_path']}  [{p['difficulty']}]  "
              f"target={[round(v) for v in p['target_vector']]}")

    if args.dry_run:
        print("\n[dry-run] not writing")
        return 0

    os.makedirs(os.path.dirname(args.cache), exist_ok=True)
    with open(args.cache, "w") as f:
        json.dump({"poses": new_poses}, f, indent=2)
    print(f"\nWrote {args.cache}")
    return 0


if __name__ == "__main__":
    sys.exit(main())