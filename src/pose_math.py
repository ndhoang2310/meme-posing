import numpy as np
import sys
import os

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)
from src.config import SIMILARITY_THRESH, UPPER_BODY_ONLY


def calculate_angle(a, b, c):
    """Calculate angle between three points A, B, C (B is the vertex)."""
    a = np.array(a)
    b = np.array(b)
    c = np.array(c)

    radians = np.arctan2(c[1] - b[1], c[0] - b[0]) - np.arctan2(a[1] - b[1], a[0] - b[0])
    angle = np.abs(radians * 180.0 / np.pi)

    if angle > 180.0:
        angle = 360 - angle

    return float(angle)


def _point(lm):
    """Return (x, y) from a landmark object, dict or tuple."""
    if isinstance(lm, dict):
        return lm['x'], lm['y']
    if hasattr(lm, 'x'):
        return lm.x, lm.y
    return lm[0], lm[1]


def joint_angles(landmarks):
    """Extract joint angles from MediaPipe pose landmarks.

    When UPPER_BODY_ONLY is True, only the 4 upper-body angles are returned
    (elbows + shoulders); hip and knee angles are skipped so the game matches
    only the torso/arms and ignores the legs.

    Returns list of 4 floats [theta1..theta4] (upper body) or
    8 floats [theta1..theta8] (full body).
    """
    # MediaPipe pose landmark indices
    # 11: Left shoulder, 12: Right shoulder
    # 13: Left elbow, 14: Right elbow
    # 15: Left wrist, 16: Right wrist
    # 23: Left hip, 24: Right hip
    # 25: Left knee, 26: Right knee
    # 27: Left ankle, 28: Right ankle

    # theta1, theta2: Elbow angle left/right
    theta1 = calculate_angle(
        _point(landmarks[11]),
        _point(landmarks[13]),
        _point(landmarks[15]),
    )
    theta2 = calculate_angle(
        _point(landmarks[12]),
        _point(landmarks[14]),
        _point(landmarks[16]),
    )

    # theta3, theta4: Shoulder angle left/right
    theta3 = calculate_angle(
        _point(landmarks[23]),
        _point(landmarks[11]),
        _point(landmarks[13]),
    )
    theta4 = calculate_angle(
        _point(landmarks[24]),
        _point(landmarks[12]),
        _point(landmarks[14]),
    )

    angles = [theta1, theta2, theta3, theta4]

    if not UPPER_BODY_ONLY:
        # theta5, theta6: Hip angle left/right
        theta5 = calculate_angle(
            _point(landmarks[11]),
            _point(landmarks[23]),
            _point(landmarks[25]),
        )
        theta6 = calculate_angle(
            _point(landmarks[12]),
            _point(landmarks[24]),
            _point(landmarks[26]),
        )

        # theta7, theta8: Knee angle left/right
        theta7 = calculate_angle(
            _point(landmarks[23]),
            _point(landmarks[25]),
            _point(landmarks[27]),
        )
        theta8 = calculate_angle(
            _point(landmarks[24]),
            _point(landmarks[26]),
            _point(landmarks[28]),
        )

        angles = [theta1, theta2, theta3, theta4, theta5, theta6, theta7, theta8]

    return angles


def cosine_similarity(v1, v2):
    """Calculate cosine similarity between two 8-dimensional vectors."""
    v1 = np.array(v1, dtype=float)
    v2 = np.array(v2, dtype=float)

    dot = np.dot(v1, v2)
    norm1 = np.linalg.norm(v1)
    norm2 = np.linalg.norm(v2)

    if norm1 == 0 or norm2 == 0:
        return 0.0

    return float(dot / (norm1 * norm2))


def pose_match_similarity(player_angles, target_angles, tolerance=30.0):
    """Discriminative 0-1 pose match score based on per-joint angular error.

    More reliable than cosine similarity for angles: each of the 8 joints
    contributes equally. Score is 1.0 for a perfect match and drops to 0.0
    when a joint is off by more than ``2 * tolerance`` degrees. A pose that
    is genuinely different yields a low score regardless of overall magnitude.

    Returns 0.0 if vectors have different lengths.
    """
    a1 = np.array(player_angles, dtype=float)
    a2 = np.array(target_angles, dtype=float)
    if a1.size == 0 or a2.size == 0 or a1.size != a2.size:
        return 0.0

    # Angular error per joint (degrees), symmetric wrap-around
    err = np.abs(a1 - a2)
    err = np.minimum(err, 360.0 - err)

    # Linear ramp: 0 deg -> 1.0, 2*tolerance deg -> 0.0
    per_joint = np.clip(1.0 - err / (2.0 * tolerance), 0.0, 1.0)
    return float(np.mean(per_joint))


def is_pose_match(player_angles, target_angles, threshold=SIMILARITY_THRESH):
    """Check if player pose matches target pose within threshold."""
    sim = pose_match_similarity(player_angles, target_angles)
    return sim >= threshold, sim