import cv2
import threading
import queue
import time
import sys
import os
import numpy as np

from src.config import UPPER_BODY_ONLY, UPPER_BODY_LANDMARKS

# Guarded import: the module must still be importable when mediapipe is missing.
try:
    import mediapipe as mp
except ImportError:
    mp = None

HAS_MEDIAPIPE_TASKS = False
if mp is not None:
    try:
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python.vision import (
            PoseLandmarkerOptions, PoseLandmarker, RunningMode,
        )
        HAS_MEDIAPIPE_TASKS = True
    except Exception:
        HAS_MEDIAPIPE_TASKS = False

# Legacy solutions API (more tolerant of older mediapipe versions)
HAS_MEDIAPIPE_SOLUTIONS = mp is not None and hasattr(mp, 'solutions')

DEFAULT_MODEL_PATHS = [
    'pose_landmarker.task',
    'pose_landmarker_full.task',
    'pose_landmarker_lite.task',
]


class VisionWorker(threading.Thread):
    """Thread 1: Vision worker - captures camera, runs MediaPipe pose, extracts features.

    1v1 split-frame detection:
    - Two VIDEO-mode PoseLandmarker instances, each pinned to ONE half of the
      frame with num_poses=1. Player identity is fixed by construction (no index
      shuffling), landmark smoothing stays enabled, and two nearby players cannot
      suppress each other via whole-frame NMS.
    - The two instances run concurrently on two threads (each instance internally
      serializes its own C++ graph; inference releases the GIL).
    - If the Tasks API is unavailable: fall back to the legacy solutions API
      (single instance, full frame) or to simulated pose data.
    """

    def __init__(self, queue_size=1, camera_index=0, use_fallback=False, model_path=None):
        super().__init__(daemon=True)
        self.queue = queue.Queue(maxsize=queue_size)
        self.camera_index = camera_index
        self.running = False
        self.frame_count = 0
        self.use_fallback = use_fallback
        self.pose = None            # legacy solutions API fallback
        self._landmarkers = []      # two split-half PoseLandmarker instances
        self._frame_ts = 0          # monotonic ms timestamp for VIDEO mode
        self._model_name = "N/A"

        if not use_fallback:
            if HAS_MEDIAPIPE_TASKS:
                try:
                    self._create_split_landmarkers(model_path)
                except Exception as e:
                    print(f"MediaPipe Tasks API failed: {e}")
                    self._landmarkers = []

            if not self._landmarkers and HAS_MEDIAPIPE_SOLUTIONS:
                try:
                    self.pose = mp.solutions.pose.Pose(
                        static_image_mode=True,
                        model_complexity=1,
                        min_detection_confidence=0.5,
                        min_tracking_confidence=0.5,
                    )
                    print("Using MediaPipe legacy solutions Pose API")
                except Exception as e:
                    print(f"MediaPipe legacy API failed: {e}")
                    self.pose = None

            if not self._landmarkers and self.pose is None:
                print("No MediaPipe API available. Falling back to simulated pose.")
                self.use_fallback = True

        if self.use_fallback:
            print("Using simulated pose data for demo")

        # Player data storage
        self.player_data = {
            'left': None,
            'right': None
        }

    # ------------------------------------------------------------------
    # Landmarker setup
    # ------------------------------------------------------------------
    def _resolve_model_path(self, model_path):
        candidates = []
        if model_path:
            candidates.append(model_path)
        assets_models = os.path.join(os.path.dirname(__file__), '..', 'assets', 'models')
        for name in DEFAULT_MODEL_PATHS:
            candidates.append(os.path.join(assets_models, name))
        for c in candidates:
            c = os.path.abspath(c)
            if os.path.exists(c):
                return c
        raise FileNotFoundError(
            f"pose_landmarker model not found. Looked in: {', '.join(candidates)}")

    def _create_split_landmarkers(self, model_path):
        resolved = self._resolve_model_path(model_path)
        base_options = BaseOptions(model_asset_path=resolved)
        options = PoseLandmarkerOptions(
            base_options=base_options,
            running_mode=RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=0.5,
            min_pose_presence_confidence=0.5,
            min_tracking_confidence=0.4,
            output_segmentation_masks=False,
        )
        left = PoseLandmarker.create_from_options(options)
        right = PoseLandmarker.create_from_options(options)
        self._landmarkers = [left, right]
        self._model_name = os.path.basename(resolved)
        print(f"Using MediaPipe PoseLandmarker (VIDEO, split-frame x2): {self._model_name}")

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------
    def run(self):
        """Main thread loop: capture camera and process pose."""
        cap = cv2.VideoCapture(self.camera_index)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

        self.running = True
        last_time = time.time()

        while self.running:
            try:
                ret, frame = cap.read()
                if not ret:
                    if self.frame_count > 10:
                        print("Warning: Lost camera frame, retrying...")
                    self.frame_count += 1
                    if self.frame_count > 50:
                        print("Error: Camera unavailable, stopping vision worker.")
                        break
                    time.sleep(0.1)
                    continue

                self.frame_count = 0

                # Mirror frame (landmarks stay aligned with the displayed image)
                frame = cv2.flip(frame, 1)

                if self.use_fallback:
                    # Use simulated pose data
                    left_player, right_player = self._simulate_pose_data(frame.shape)
                elif self._landmarkers:
                    # Split-frame: one VIDEO-mode instance per half, in parallel
                    try:
                        left_player, right_player = self._detect_split_halves(frame)
                    except Exception as e:
                        print(f"Split-frame pose detection error: {e}. Switching to fallback.")
                        self.use_fallback = True
                        left_player, right_player = self._simulate_pose_data(frame.shape)
                elif self.pose is not None:
                    # Legacy solutions API fallback (single instance, full frame)
                    try:
                        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                        results = self.pose.process(rgb_frame)
                        left_player, right_player = self._process_legacy_detection(results, frame.shape)
                    except Exception as e:
                        print(f"Pose detection error: {e}. Switching to fallback.")
                        self.use_fallback = True
                        left_player, right_player = self._simulate_pose_data(frame.shape)
                else:
                    left_player, right_player = self._simulate_pose_data(frame.shape)

                # Update queue with latest data (override if not empty)
                try:
                    self.queue.put_nowait({
                        'frame': frame,
                        'left': left_player,
                        'right': right_player,
                        'timestamp': time.time()
                    })
                except queue.Full:
                    pass  # Drop old, keep latest

                # Throttle to ~30 FPS
                elapsed = time.time() - last_time
                if elapsed < 0.033:
                    time.sleep(0.033 - elapsed)
                last_time = time.time()

            except Exception as e:
                print(f"Vision worker error: {e}")
                time.sleep(0.1)

        cap.release()
        if self.use_fallback is False and self.pose is not None:
            pass  # detector has its own cleanup
        for lm in self._landmarkers:
            try:
                lm.close()
            except Exception:
                pass
        try:
            self.queue.put_nowait({'shutdown': True})
        except queue.Full:
            pass

    # ------------------------------------------------------------------
    # Split-frame detection (Tasks API)
    # ------------------------------------------------------------------
    def _detect_split_halves(self, frame):
        """Run one VIDEO-mode PoseLandmarker per frame half, in parallel."""
        h, w = frame.shape[:2]
        if w < 40:
            return None, None
        mid_x = w // 2
        self._frame_ts += 33  # strictly-increasing, monotonic ms

        left_crop = frame[:, :mid_x]
        right_crop = frame[:, mid_x:]

        slots = [None, None]
        crops = [(left_crop, 0), (right_crop, mid_x)]
        threads = []
        for i, (crop, offset_x) in enumerate(crops):
            t = threading.Thread(
                target=self._detect_half,
                args=(self._landmarkers[i], crop, offset_x, self._frame_ts, slots, i),
            )
            t.start()
            threads.append(t)
        for t in threads:
            t.join()

        left_player = self._build_player(slots[0])
        right_player = self._build_player(slots[1])
        return left_player, right_player

    def _detect_half(self, landmarker, crop, offset_x, ts, slots, idx):
        try:
            rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = landmarker.detect_for_video(mp_image, ts)
            slots[idx] = (result, offset_x, crop.shape[1], crop.shape[0])
        except Exception as e:
            print(f"Half detection error: {e}")
            slots[idx] = None

    def _build_player(self, slot):
        """Convert one half's detection result into player dict in FULL-frame pixel coords."""
        if not slot:
            return None
        result, offset_x, crop_w, crop_h = slot
        if not result.pose_landmarks:
            return None
        pose = result.pose_landmarks[0]  # num_poses=1

        landmarks_raw = [
            (lm.x * crop_w + offset_x, lm.y * crop_h) for lm in pose
        ]

        if UPPER_BODY_ONLY:
            pts = [landmarks_raw[i] for i in UPPER_BODY_LANDMARKS if i < len(landmarks_raw)]
        else:
            pts = landmarks_raw

        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        bbox_w = max(max_x - min_x, 0.0)
        bbox_h = max(max_y - min_y, 0.0)

        return {
            'bounding_box': (int(min_x), int(min_y), int(bbox_w), int(bbox_h)),
            'landmarks_raw': landmarks_raw,
            'is_detected': True,
            'angles': None,      # computed by main thread
            'similarity': 0.0,
            'bbox_area': bbox_w * bbox_h,
        }

    def _simulate_pose_data(self, frame_shape):
        """Generate simulated pose data for demo purposes."""
        h, w = frame_shape[:2]

        # Generate 33 random-ish landmarks that look like a pose
        np.random.seed(int(time.time()) % 1000)
        landmarks = []
        for i in range(33):
            if i == 0:  # Nose
                lm_x = w // 2 + np.random.randint(-50, 50)
                lm_y = h // 3 + np.random.randint(-30, 30)
            elif i in [11, 12]:  # Shoulders
                lm_x = w // 2 + (1 if i == 12 else -1) * (w // 4 + np.random.randint(-30, 30))
                lm_y = h // 2 + np.random.randint(-30, 30)
            elif i in [13, 14]:  # Elbows
                lm_x = w // 2 + (1 if i == 14 else -1) * (w // 3 + np.random.randint(-30, 30))
                lm_y = h // 2 + (h // 6 if i == 14 else -h // 6) + np.random.randint(-30, 30)
            elif i in [15, 16]:  # Wrists
                lm_x = w // 2 + (1 if i == 16 else -1) * (3 * w // 8 + np.random.randint(-30, 30))
                lm_y = h // 2 + (h // 3 if i == 16 else -h // 3) + np.random.randint(-30, 30)
            elif i in [23, 24]:  # Hips
                lm_x = w // 2 + (1 if i == 24 else -1) * (w // 5 + np.random.randint(-30, 30))
                lm_y = 2 * h // 3 + np.random.randint(-30, 30)
            elif i in [25, 26]:  # Knees
                lm_x = w // 2 + (1 if i == 26 else -1) * (w // 4 + np.random.randint(-30, 30))
                lm_y = 5 * h // 6 + np.random.randint(-30, 30)
            elif i in [27, 28]:  # Ankles
                lm_x = w // 2 + (1 if i == 28 else -1) * (w // 3 + np.random.randint(-30, 30))
                lm_y = h + np.random.randint(-20, 20)
            else:
                lm_x = w // 2 + np.random.randint(-50, 50)
                lm_y = h // 2 + np.random.randint(-50, 50)

            # Normalize to 0-1 range
            landmarks.append((lm_x / w, lm_y / h))

        # Left player - use left-side landmarks, Right player - mirror
        left_landmarks = landmarks[:]
        right_landmarks = [(1 - x, y) if x > 0.5 else (x, y) for x, y in landmarks]

        def _make_player(pts, px_w, px_h):
            if UPPER_BODY_ONLY:
                bbox_pts = [pts[i] for i in UPPER_BODY_LANDMARKS if i < len(pts)]
            else:
                bbox_pts = pts
            xs = [p[0] for p in bbox_pts]
            ys = [p[1] for p in bbox_pts]
            min_x, max_x = min(xs) * px_w, max(xs) * px_w
            min_y, max_y = min(ys) * px_h, max(ys) * px_h
            bbox = (int(min_x), int(min_y),
                    int(max(max_x - min_x, 100)), int(max(max_y - min_y, 200)))
            return {
                'bounding_box': bbox,
                'landmarks_raw': pts,
                'is_detected': True,
                'angles': None,
                'similarity': 0.0,
                'bbox_area': bbox[2] * bbox[3]
            }

        left_player = _make_player(left_landmarks, w, h)
        right_player = _make_player(right_landmarks, w, h)
        return left_player, right_player

    def _process_legacy_detection(self, results, frame_shape):
        """Process MediaPipe legacy solutions API result."""
        h, w = frame_shape[:2]
        mid_x = w // 2

        left_player = None
        right_player = None

        if results.pose_landmarks:
            landmarks = results.pose_landmarks[0]  # First person detected

            landmarks_raw = [(lm.x * w, lm.y * h) for lm in landmarks]

            if UPPER_BODY_ONLY:
                bbox_pts = [landmarks_raw[i] for i in UPPER_BODY_LANDMARKS if i < len(landmarks_raw)]
            else:
                bbox_pts = landmarks_raw
            bx = [p[0] for p in bbox_pts]
            by = [p[1] for p in bbox_pts]
            min_x, max_x = min(bx), max(bx)
            min_y, max_y = min(by), max(by)
            bbox_width = max_x - min_x
            bbox_height = max_y - min_y
            bbox_area = bbox_width * bbox_height

            person_center_x = (min_x + max_x) / 2

            player_data = {
                'bounding_box': (int(min_x), int(min_y), int(bbox_width), int(bbox_height)),
                'landmarks_raw': landmarks_raw,
                'is_detected': True,
                'angles': None,
                'similarity': 0.0,
                'bbox_area': bbox_area
            }

            if person_center_x < mid_x:
                left_player = player_data
            else:
                right_player = player_data

        return left_player, right_player

    def get_latest_frame(self):
        """Get the latest frame packet from queue without blocking."""
        try:
            return self.queue.get_nowait()
        except queue.Empty:
            return None

    def stop(self):
        self.running = False


if __name__ == "__main__":
    worker = VisionWorker(use_fallback=True)
    worker.start()
    print("Vision worker started. Press Ctrl+C to stop.")

    try:
        while True:
            packet = worker.get_latest_frame()
            if packet and 'shutdown' not in str(packet):
                left = packet['left']
                right = packet['right']
                if left and right:
                    print(f"Frame: L bbox_area={left['bbox_area']}, R bbox_area={right['bbox_area']}")
            import time as t
            t.sleep(0.1)
    except KeyboardInterrupt:
        worker.stop()
        worker.join()
        print("Stopped.")