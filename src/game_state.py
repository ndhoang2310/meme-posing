import time
import random
from collections import deque

try:
    from src.config import SIMILARITY_THRESH, HOLD_DURATION
except ImportError:
    SIMILARITY_THRESH = 0.88
    HOLD_DURATION = 0.4


class PlayerState:
    """Data class for single player vision data."""

    def __init__(self):
        self.bounding_box = (0, 0, 0, 0)  # x, y, w, h
        self.landmarks_raw = []  # list of (x, y) tuples
        self.angles_vector = None  # 4-element list (upper body) or 8-element (full)
        self.is_detected = False
        self.similarity = 0.0
        self.bbox_area = 0


class FramePacket:
    """Data class for frame packet from vision worker."""
    def __init__(self):
        self.frame = None  # numpy array
        self.player_left = PlayerState()
        self.player_right = PlayerState()
        self.timestamp = 0.0


class GameStateFSM:
    """Finite State Machine for POSE MATCH 1V1 game."""

    def __init__(self, single_player=False):
        self.state = "IDLE"
        self.single_player = single_player

        # Timers
        self.countdown_timer = 0.0
        self.game_timer = 0.0
        self.pose_timer = 0.0
        self.hold_timer = {"left": 0.0, "right": 0.0}
        self.pause_timer = 0.0
        self.manual_pause = False

        # Game state
        self.score = {"left": 0, "right": 0}
        self.current_pose_index = 0
        self.poses_completed = 0
        self.round_index = 0
        self.round_order = []

        # Detection tracking
        self.pose_stable_counter = 0
        self.pose_stable_threshold = 0.4  # seconds (about 12 frames @ 30fps)
        self.lost_player_timer = 0.0
        self.pose_timeout = self.POSE_TIMEOUT
        self._idle_start_time = None

        # Debug
        self.debug = False

        # Pose targets (will be loaded from poses_cache.json)
        self.pose_targets = []  # list of angle vectors
        self.current_target_index = 0

    def update(self, frame_packet, dt):
        """Update FSM based on new frame data."""
        dt = max(dt, 0.001)  # minimum delta time

        if self.state == "IDLE":
            self._update_idle(frame_packet, dt)

        elif self.state == "COUNTDOWN":
            self._update_countdown(dt)

        elif self.state == "PLAYING":
            self._update_playing(frame_packet, dt)

        elif self.state == "PAUSED":
            self._update_paused(frame_packet, dt)

        elif self.state == "GAME_OVER":
            self._update_game_over(dt)

        return self.state

    def _update_idle(self, packet, dt):
        """IDLE state: wait for player(s) to be detected steadily."""
        left_detected = packet.player_left.is_detected
        right_detected = True if self.single_player else packet.player_right.is_detected

        # Track stable detection
        if left_detected and right_detected:
            self.lost_player_timer = 0.0
            # Check if detected for 2 seconds
            if self._idle_start_time is None:
                self._idle_start_time = time.time()
            elif time.time() - self._idle_start_time >= 2.0:
                self.state = "COUNTDOWN"
                self.countdown_timer = GameStateFSM.COUNTDOWN_DURATION
                self._idle_start_time = None
        else:
            # At startup, keep the onboarding screen stable until both
            # players are detected. PAUSED is reserved for losing a player
            # during an active match, not for the initial waiting state.
            self.lost_player_timer = 0.0
            self._idle_start_time = None

    def _update_countdown(self, dt):
        """COUNTDOWN state: 3-2-1 go."""
        self.countdown_timer -= dt
        if self.countdown_timer <= 0:
            self.state = "PLAYING"
            self.game_timer = GameStateFSM.GAME_DURATION
            self.pose_timer = GameStateFSM.POSE_TIMEOUT
            self.hold_timer = {"left": 0.0, "right": 0.0}
            # Load first pose target
            self._load_first_pose()

    def _update_playing(self, packet, dt):
        """PLAYING state: main game logic."""
        self.game_timer -= dt
        self.pose_timer -= dt

        left = packet.player_left
        right = packet.player_right

        # Update hold timer for each player who is stable
        left_stable = left.is_detected and left.similarity >= SIMILARITY_THRESH
        right_stable = right.is_detected and right.similarity >= SIMILARITY_THRESH

        if left_stable:
            self.hold_timer["left"] += dt
        else:
            self.hold_timer["left"] = 0.0
        if right_stable:
            self.hold_timer["right"] += dt
        else:
            self.hold_timer["right"] = 0.0

        # The first player to hold the pose long enough wins this round.
        left_done = self.hold_timer["left"] >= HOLD_DURATION
        right_done = self.hold_timer["right"] >= HOLD_DURATION

        winner = None
        if left_done and right_done:
            winner = "left" if self.hold_timer["left"] >= self.hold_timer["right"] else "right"
        elif left_done:
            winner = "left"
        elif right_done:
            winner = "right"

        if winner is not None:
            self.score[winner] += 1
            self.hold_timer = {"left": 0.0, "right": 0.0}
            self.pose_stable_counter = 0
            self.poses_completed += 1
            self._advance_round()

        # A missed pose still consumes its 6-second round, then moves on.
        if self.state == "PLAYING" and self.pose_timer <= 0:
            self._advance_round()

        # Safety timer: a normal match also ends after 9 x 6 seconds.
        if self.game_timer <= 0:
            self.state = "GAME_OVER"

        if self.state != "PLAYING":
            return

        # Check player loss
        if self.single_player:
            lost = not left.is_detected
        else:
            lost = not left.is_detected or not right.is_detected
        if lost:
            self.lost_player_timer += dt
            if self.lost_player_timer > 1.5:
                self.state = "PAUSED"
                self.pause_timer = 3.0
        else:
            self.lost_player_timer = 0.0

    def _update_paused(self, packet, dt):
        """PAUSED state: wait for player(s) to return, then re-run countdown."""
        self.pause_timer -= dt

        left_detected = packet.player_left.is_detected
        right_detected = True if self.single_player else packet.player_right.is_detected

        # Manual pause (SPACE): ignore detection, wait for timer or manual resume
        if self.manual_pause:
            if self.pause_timer <= 0:
                self.state = "IDLE"
                self.manual_pause = False
        else:
            # Lost player pause: resume when player(s) back
            if left_detected and right_detected:
                self.state = "COUNTDOWN"
                self.countdown_timer = GameStateFSM.COUNTDOWN_DURATION
                self.pause_timer = 0.0
                self.lost_player_timer = 0.0
                self.hold_timer = {"left": 0.0, "right": 0.0}
                self.pose_timer = GameStateFSM.POSE_TIMEOUT
            elif self.pause_timer <= 0:
                self.state = "IDLE"

    def _update_game_over(self, dt):
        """GAME_OVER state: show final scores."""
        pass  # Handled in renderer

    def _load_first_pose(self):
        """Create a random nine-round sequence and load its first target."""
        self.round_order = self._build_round_order()
        self.round_index = 0
        self.current_target_index = self.round_order[0] if self.round_order else 0
        self.pose_timer = GameStateFSM.POSE_TIMEOUT
        self.hold_timer = {"left": 0.0, "right": 0.0}

    def _build_round_order(self):
        """Return nine shuffled target indices, allowing a repeated target."""
        if not self.pose_targets:
            return []

        order = []
        while len(order) < self.MATCH_ROUNDS:
            cycle = list(range(len(self.pose_targets)))
            random.shuffle(cycle)
            if order and len(cycle) > 1 and cycle[0] == order[-1]:
                cycle[0], cycle[1] = cycle[1], cycle[0]
            order.extend(cycle)
        return order[:self.MATCH_ROUNDS]

    def _advance_round(self):
        """Move to the next random target or finish the match."""
        self.round_index += 1
        if self.round_index >= self.MATCH_ROUNDS:
            self.state = "GAME_OVER"
            return False

        self.current_target_index = self.round_order[self.round_index]
        self.pose_timer = GameStateFSM.POSE_TIMEOUT
        self.hold_timer = {"left": 0.0, "right": 0.0}
        return True

    def current_target(self):
        """Return the current target pose dict (or None)."""
        if not self.pose_targets:
            return None
        if 0 <= self.current_target_index < len(self.pose_targets):
            return self.pose_targets[self.current_target_index]
        return None

    # Constants
    COUNTDOWN_DURATION = 3.0
    MATCH_ROUNDS = 9
    POSE_TIMEOUT = 6.0
    GAME_DURATION = MATCH_ROUNDS * POSE_TIMEOUT

    @classmethod
    def get_constants(cls):
        return {
            "COUNTDOWN_DURATION": cls.COUNTDOWN_DURATION,
            "MATCH_ROUNDS": cls.MATCH_ROUNDS,
            "GAME_DURATION": cls.GAME_DURATION,
            "POSE_TIMEOUT": cls.POSE_TIMEOUT
        }
