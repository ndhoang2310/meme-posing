#!/usr/bin/env python3
"""Visualiser la pose détectée sur une/des image(s).

Détecte le squelette (MediaPipe Pose) sur une image ou tout un dossier,
dessine le squelette + la bounding box (thân trên si UPPER_BODY_ONLY),
et enregistre la version annotée dans un dossier de sortie.

Usage:
    ./venv/bin/python tools/visualize_pose.py --input assets/poses
    ./venv/bin/python tools/visualize_pose.py --input meme.jpg --out /tmp/annotated
    ./venv/bin/python tools/visualize_pose.py --input assets/poses --show
"""

import argparse
import os
import sys

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import cv2
import numpy as np

from src.config import UPPER_BODY_ONLY, UPPER_BODY_LANDMARKS

IMAGE_EXTS = {".png", ".jpeg", ".jpg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}

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


def mediapipe_pose():
    """Build a static-image pose detector (legacy solutions API - robust)."""
    import mediapipe as mp
    return mp.solutions.pose.Pose(
        static_image_mode=True,
        model_complexity=1,
        min_detection_confidence=0.4,
        min_tracking_confidence=0.4,
    )


def detect(image_path, detector):
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


def draw_pose(img, landmarks_px, color=(0, 229, 255), thickness=3):
    """Draw skeleton + bbox on an image in pixel coordinates."""
    pts = {}
    for idx in range(33):
        if idx < len(landmarks_px):
            pts[idx] = (int(round(landmarks_px[idx][0])), int(round(landmarks_px[idx][1])))

    for a, b in SKELETON_CONNECTIONS:
        if a in pts and b in pts:
            cv2.line(img, pts[a], pts[b], color, thickness)

    # Bbox over upper-body landmarks (or all)
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


def collect_images(path):
    """Return list of image paths for a file or a directory."""
    if os.path.isfile(path):
        ext = os.path.splitext(path)[1].lower()
        return [path] if ext in IMAGE_EXTS else []
    if os.path.isdir(path):
        return [
            os.path.join(path, name)
            for name in sorted(os.listdir(path))
            if os.path.splitext(name)[1].lower() in IMAGE_EXTS
        ]
    return []


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", required=True,
                        help="Image file or folder of images to annotate")
    parser.add_argument("--out", default=os.path.join(PROJECT_ROOT, "assets", "poses_annotated"),
                        help="Output folder for annotated images")
    parser.add_argument("--show", action="store_true",
                        help="Show each annotated image in a window (press any key to continue)")
    args = parser.parse_args()

    images = collect_images(args.input)
    if not images:
        print(f"No images found at {args.input}")
        return 1

    os.makedirs(args.out, exist_ok=True)
    detector = mediapipe_pose()
    try:
        for img_path in images:
            landmarks_px = detect(img_path, detector)
            frame = cv2.imread(img_path)
            if landmarks_px is None:
                print(f"  ! no person detected: {os.path.basename(img_path)}")
                continue

            draw_pose(frame, landmarks_px)

            name = os.path.splitext(os.path.basename(img_path))[0]
            out_path = os.path.join(args.out, f"{name}_pose.png")
            cv2.imwrite(out_path, frame)
            print(f"  ? annotated: {os.path.basename(img_path)} -> {os.path.relpath(out_path, PROJECT_ROOT)}")

            if args.show:
                cv2.imshow("Pose", frame)
                cv2.waitKey(0)
    finally:
        detector.close()
        cv2.destroyAllWindows()

    print(f"Done. Output folder: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
