#!/usr/bin/env python3
"""Outils de test autonome - Pose Test (une moitié de caméra).

Ouvre la caméra, utilise UN seul PoseLandmarker (VIDEO mode) sur la moitié
gauche du cadre, puis affiche dans une fenêtre OpenCV :
  - le crop gauche (mirroré, comme dans le jeu)
  - le squelette + bounding box du joueur (placement P1 / offset_x = 0)
  - les angles articulaires en direct (même logique que src/pose_math) —
    thân trên seulement si UPPER_BODY_ONLY, sinon 8 angles

Usage:
    ./venv/bin/python tools/pose_test.py [--camera 0] [--scale 1.5] [--sim]
"""

import os
import sys
import time
import argparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cv2
import numpy as np

from src.pose_math import joint_angles, pose_match_similarity
from src.config import UPPER_BODY_ONLY, SIMILARITY_THRESH, HOLD_DURATION
from src.game_state import GameStateFSM, FramePacket, PlayerState

try:
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import (
        PoseLandmarkerOptions, PoseLandmarker, RunningMode,
    )
    HAS_TASKS = True
except Exception:
    mp = None
    HAS_TASKS = False

HAS_SOLUTIONS = mp is not None and hasattr(mp, 'solutions')

MODEL_CANDIDATES = [
    'pose_landmarker.task',
    'pose_landmarker_full.task',
    'pose_landmarker_lite.task',
]

if UPPER_BODY_ONLY:
    SKELETON_CONNECTIONS = [
        (11, 13), (13, 15),
        (12, 14), (14, 16),
        (11, 23), (12, 24),
        (23, 24),
        (11, 12),
    ]
    KEY_INDICES = {11, 12, 13, 14, 15, 16, 23, 24}
    ANGLE_LABELS = [
        "L-elbow", "R-elbow",
        "L-shoulder", "R-shoulder",
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
    KEY_INDICES = {11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28}
    ANGLE_LABELS = [
        "L-elbow", "R-elbow",
        "L-shoulder", "R-shoulder",
        "L-hip", "R-hip",
        "L-knee", "R-knee",
    ]


def resolve_model_path(model_path):
    candidates = []
    if model_path:
        candidates.append(model_path)
    assets_models = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'models')
    for name in MODEL_CANDIDATES:
        candidates.append(os.path.join(assets_models, name))
    for c in candidates:
        c = os.path.abspath(c)
        if os.path.exists(c):
            return c
    raise FileNotFoundError(f"Modèle pose_landmarker introuvable. Cherché dans: {candidates}")


def create_landmarker(model_path):
    resolved = resolve_model_path(model_path)
    options = PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=resolved),
        running_mode=RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.4,
        output_segmentation_masks=False,
    )
    return PoseLandmarker.create_from_options(options)


def run_legacy(frame, pose):
    """Legacy solutions fallback - détection sur le cadre complet."""
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = pose.process(rgb)
    if not results.pose_landmarks:
        return None
    return [(lm.x, lm.y) for lm in results.pose_landmarks[0]]


def draw_skeleton(img, landmarks_px, color=(0, 229, 255), thickness=3):
    """Dessine le squelette sur un crop en coordonnées pixel (déjà scalées)."""
    pts = {}
    for idx in KEY_INDICES:
        if idx < len(landmarks_px):
            x, y = landmarks_px[idx]
            pts[idx] = (int(round(x)), int(round(y)))

    for a, b in SKELETON_CONNECTIONS:
        if a in pts and b in pts:
            cv2.line(img, pts[a], pts[b], color, thickness)

    for idx, p in pts.items():
        cv2.circle(img, p, 5, color, -1)
        cv2.circle(img, p, 2, (4, 6, 18), -1)

    return pts


def draw_angle_panel(canvas, angles, panel_x):
    """Affiche les angles dans un bandeau à droite du crop (à côté de la vidéo)."""
    x0 = panel_x + 30
    y0 = 30
    line_h = 32

    cv2.putText(canvas, "JOINT ANGLES (deg)", (x0, y0),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (240, 245, 255), 2)

    for i, (label, angle) in enumerate(zip(ANGLE_LABELS, angles)):
        y = y0 + 40 + i * line_h
        color = (57, 255, 20) if 70.0 <= angle <= 175.0 else (255, 220, 60)
        cv2.putText(canvas, f"{i+1} {label:>10}: {angle:6.1f}", (x0, y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)

    y = y0 + 40 + len(angles) * line_h + 10
    cv2.putText(canvas, "ESC = quitter | SPACE = simuler", (x0, y),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (160, 172, 200), 1)


def load_pose_targets(path):
    """Load pose target dicts from a poses_cache.json file."""
    import json
    if not os.path.exists(path):
        print(f"Warning: pose cache not found at {path}")
        return []
    with open(path, "r") as f:
        data = json.load(f)
    raw = data.get("poses", {})
    if isinstance(raw, dict):
        return list(raw.values())
    return list(raw)


def to_player_state(data):
    """Convert a vision-style dict to a PlayerState (mirrors main.py)."""
    ps = PlayerState()
    if data:
        ps.bounding_box = data.get('bounding_box', (0, 0, 0, 0))
        ps.landmarks_raw = data.get('landmarks_raw', [])
        ps.angles_vector = data.get('angles', None)
        ps.is_detected = data.get('is_detected', False)
        ps.similarity = data.get('similarity', 0.0)
        ps.bbox_area = data.get('bbox_area', 0)
    return ps


def load_target_image(target):
    """Return the target pose image as a BGR numpy array (or None)."""
    path = target.get("image_path", "")
    if not path or not os.path.exists(path):
        return None
    img = cv2.imread(path)
    return img


def draw_game_panel(canvas, game_state, target_img, state_text, panel_x):
    """Draw a single-player game UI beside the video (to the right).

    Shows the target pose image, score, state, similarity and hold progress.
    """
    h, w = canvas.shape[:2]

    # Panel background
    cv2.rectangle(canvas, (panel_x, 0), (w, h), (16, 20, 44), -1)
    cv2.putText(canvas, "TARGET POSE", (panel_x + 20, 40),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 213, 0), 2)

    # Target image
    img_y = 70
    if target_img is not None:
        th = 260
        tw = int(target_img.shape[1] * (th / target_img.shape[0]))
        if tw > 300:
            tw = 300
            th = int(target_img.shape[0] * (tw / target_img.shape[1]))
        disp = cv2.resize(target_img, (tw, th))
        cx = panel_x + (340 - tw) // 2
        canvas[img_y:img_y + th, cx:cx + tw] = disp
    else:
        cv2.rectangle(canvas, (panel_x + 20, img_y), (panel_x + 320, img_y + 260),
                      (34, 40, 76), -1)
        cv2.putText(canvas, "NO IMAGE", (panel_x + 90, img_y + 130),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (160, 172, 200), 2)

    # State + score
    y = img_y + 300
    cv2.putText(canvas, f"STATE: {state_text}", (panel_x + 20, y),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (240, 245, 255), 2)
    y += 40
    cv2.putText(canvas, f"SCORE: {game_state.score.get('left', 0)}", (panel_x + 20, y),
                cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 229, 255), 2)
    y += 40
    cv2.putText(canvas, f"POSE: {game_state.current_target_index + 1}/"
                        f"{len(game_state.pose_targets)}", (panel_x + 20, y),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 213, 0), 2)
    y += 40
    cv2.putText(canvas, "ESC = exit | SPACE = sim", (panel_x + 20, y + 20),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (160, 172, 200), 1)


def main():
    parser = argparse.ArgumentParser(description="Pose Test - une moitié de caméra")
    parser.add_argument("--camera", type=int, default=0, help="Index caméra")
    parser.add_argument("--scale", type=float, default=1.5,
                        help="Échelle d'affichage du crop (1.0 = taille native)")
    parser.add_argument("--sim", action="store_true",
                        help="Utiliser des données de pose simulées (pas de caméra)")
    parser.add_argument("--model", type=str, default=None, help="Chemin du modèle .task")
    parser.add_argument("--side", choices=["left", "right"], default="left",
                        help="Quelle moitié du cadre tester (défaut: left)")
    parser.add_argument("--game", action="store_true",
                        help="Mode jeu 1 joueur : target + score + countdown + hold")
    parser.add_argument("--cache", type=str,
                        default=os.path.join(os.path.dirname(os.path.dirname(
                            os.path.abspath(__file__))), "data", "poses_cache.json"),
                        help="Chemin vers poses_cache.json")
    args = parser.parse_args()

    # Single-player game state
    game_state = None
    frame_packet = None
    target_img = None
    last_game_ts = time.time()
    if args.game:
        targets = load_pose_targets(args.cache)
        game_state = GameStateFSM(single_player=True)
        game_state.pose_targets = targets
        frame_packet = FramePacket()
        print(f"Mode jeu 1 joueur: {len(targets)} pose(s) cible(s) chargée(s)")

    landmarker = None
    legacy_pose = None
    simulate = args.sim
    frame_ts = 0

    if not simulate and HAS_TASKS:
        try:
            landmarker = create_landmarker(args.model)
            print("PoseLandmarker (VIDEO, un seul instance) prêt")
        except Exception as e:
            print(f"Tasks API échoué: {e}")

    if not simulate and landmarker is None and HAS_SOLUTIONS:
        try:
            legacy_pose = mp.solutions.pose.Pose(
                static_image_mode=True,
                model_complexity=1,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            print("Fallback legacy solutions Pose")
        except Exception as e:
            print(f"Legacy API échoué: {e}")

    if not simulate and landmarker is None and legacy_pose is None:
        print("Aucune API MediaPipe disponible -> mode simulé.")
        simulate = True
    if simulate:
        print("Mode simulé (pas de caméra)")

    cap = None
    if not simulate:
        cap = cv2.VideoCapture(args.camera)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    if args.side == "left":
        offset_x, lane_key = 0, "left"
    else:
        lane_key = "right"

    side = "LEFT" if args.side == "left" else "RIGHT"
    print(f"=== POSE TEST - moitié {side} ===")
    print("  ESC  quitter |  SPACE  toggle simulé")
    print("  Squelette: cyan  |  Angles verts (70-175deg), jaune sinon")

    last_time = time.time()
    fps = 0.0

    try:
        while True:
            if simulate:
                frame = np.zeros((720, 1280, 3), dtype=np.uint8)
                frame_ts += 33
            else:
                ret, frame = cap.read()
                if not ret:
                    print("Perte de frame, réessai...")
                    time.sleep(0.1)
                    continue

            frame = cv2.flip(frame, 1)
            h, w = frame.shape[:2]
            mid_x = w // 2

            if args.side == "left":
                crop = frame[:, :mid_x].copy()
                frame_crop_w = mid_x
            else:
                crop = frame[:, mid_x:].copy()
                frame_crop_w = w - mid_x

            angles = None
            landmarks_norm = None

            if simulate:
                landmarks_norm = _simulated_landmarks()
            elif landmarker is not None:
                frame_ts += 33
                rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
                mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = landmarker.detect_for_video(mp_img, frame_ts)
                if result.pose_landmarks:
                    landmarks_norm = [(lm.x, lm.y) for lm in result.pose_landmarks[0]]
            elif legacy_pose is not None:
                landmarks_norm = run_legacy(frame, legacy_pose)

            # Échelle d'affichage
            disp_w = max(2, int(crop.shape[1] * args.scale))
            disp_h = max(2, int(crop.shape[0] * args.scale))
            canvas = cv2.resize(crop, (disp_w, disp_h),
                                interpolation=cv2.INTER_LINEAR)

            status = "AUCUN joueur"
            if landmarks_norm:
                landmarks_px = [(lm[0] * disp_w, lm[1] * disp_h) for lm in landmarks_norm]
                draw_skeleton(canvas, landmarks_px)

                # bbox (placement P1 : offset_x = 0, coordonnées crop)
                xs = [p[0] for p in landmarks_px]
                ys = [p[1] for p in landmarks_px]
                bx0, by0 = int(min(xs)), int(min(ys))
                bw, bh = int(max(xs) - bx0), int(max(ys) - by0)
                cv2.rectangle(canvas, (bx0, by0), (bx0 + bw, by0 + bh),
                              (0, 229, 255), 2)

                try:
                    angles = joint_angles(landmarks_norm)
                    status = f"OK  sim={0.0:.2f}"
                except Exception as e:
                    status = f"angles ERROR: {e}"

            # --- Mode jeu 1 joueur : target + score + hold ---
            if game_state is not None:
                now = time.time()
                dt = min(max(now - last_game_ts, 0.0), 1.0 / 30.0)
                last_game_ts = now

                ps = frame_packet.player_left
                if landmarks_norm is not None and angles is not None:
                    ps.is_detected = True
                    ps.landmarks_raw = landmarks_norm
                    ps.angles_vector = angles
                    target = game_state.current_target()
                    if target:
                        tvec = target.get('target_vector', [])
                        ps.similarity = pose_match_similarity(angles, tvec[:len(angles)])
                else:
                    ps.is_detected = False
                    ps.similarity = 0.0

                game_state.update(frame_packet, dt)

                target = game_state.current_target()
                target_img = load_target_image(target) if target else None

                # Status text from game state
                status = game_state.state
                if game_state.state == "PLAYING":
                    status = f"{game_state.state} sim={ps.similarity:.2f}"

            # Barre de statut (sur la zone vidéo uniquement)
            cv2.rectangle(canvas, (0, 0), (disp_w, 24), (16, 20, 44), -1)
            cv2.putText(canvas,
                        f"{side} | {status} | {fps:.0f} fps | 'q'/'ESC' = exit"[:80],
                        (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 229, 255), 1)

            # Panneau toujours À CÔTÉ de la vidéo (jamais par-dessus)
            if game_state is not None:
                panel_w = 340
            else:
                panel_w = 330
            panel_x = disp_w
            canvas = np.pad(canvas, ((0, 0), (0, panel_w), (0, 0)),
                            constant_values=16)

            if game_state is not None:
                draw_game_panel(canvas, game_state, target_img, status, panel_x)
            else:
                if angles:
                    draw_angle_panel(canvas, angles, panel_x)
                else:
                    cv2.putText(canvas, "PAS DE POSE", (panel_x + 30, 30),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 70, 70), 2)

            cv2.imshow("Pose Test (moitie %s)" % side, canvas)

            now = time.time()
            fps = fps * 0.9 + (1.0 / max(now - last_time, 1e-6)) * 0.1
            last_time = now

            key = cv2.waitKey(1) & 0xFF
            if key in (27, ord('q')):
                break
            if key == ord(' '):
                simulate = not simulate
                print("Mode simulé" if simulate else "Mode caméra")
    except KeyboardInterrupt:
        pass
    finally:
        if cap is not None:
            cap.release()
        if landmarker is not None:
            try:
                landmarker.close()
            except Exception:
                pass
        cv2.destroyAllWindows()
        print("Fermé.")


def _simulated_landmarks():
    """Landmarks normalisés d'une pose 'bras levés' - stable pour tester l'affichage."""
    np.random.seed(42)
    lm = []
    for i in range(33):
        lm.append((np.random.uniform(0.15, 0.85),
                   np.random.uniform(0.05, 0.95)))
    # Override pour une pose lisible
    lm[0] = (0.5, 0.35)           # nose
    lm[11], lm[12] = (0.32, 0.42), (0.68, 0.42)   # shoulders
    lm[13], lm[14] = (0.20, 0.25), (0.80, 0.25)   # elbows hauts
    lm[15], lm[16] = (0.12, 0.10), (0.88, 0.10)   # poignets
    lm[23], lm[24] = (0.38, 0.72), (0.62, 0.72)   # hips
    lm[25], lm[26] = (0.40, 0.85), (0.60, 0.85)   # genoux
    lm[27], lm[28] = (0.42, 0.97), (0.58, 0.97)   # chevilles
    return lm


if __name__ == "__main__":
    main()