SIMILARITY_THRESH = 0.8
HOLD_DURATION = 0.4
UPPER_BODY_ONLY = True
# Landmark indices considered "upper body" (head + arms + hips). Legs
# (knees/ankles/feet) are excluded. When UPPER_BODY_ONLY is True these drive the
# bounding box; the drawn skeleton and scoring only use the upper-body joints.
UPPER_BODY_LANDMARKS = list(range(0, 17)) + [23, 24]
POSE_TIMEOUT = 6.0
GAME_DURATION = 54.0
COUNTDOWN_DURATION = 3.0
DEBUG_MODE = False
