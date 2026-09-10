#!/usr/bin/env python3
"""Main entry point for POSE MATCH 1V1 Demo."""

import os
import sys
import time
import argparse
import pygame  # Add this line

# Add project root to path (parent of src/)
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from src.config import COUNTDOWN_DURATION, DEBUG_MODE
from src.vision_worker import VisionWorker
from src.pose_math import joint_angles, pose_match_similarity
from src.game_state import GameStateFSM, PlayerState, FramePacket
from src.renderer import init_pygame, quit_pygame, Renderer


def dict_to_player_state(data):
    """Convert vision_worker dict to PlayerState object."""
    ps = PlayerState()
    if data:
        bbox = data.get('bounding_box', (0, 0, 0, 0))
        ps.bounding_box = bbox
        ps.landmarks_raw = data.get('landmarks_raw', [])
        ps.angles_vector = data.get('angles', None)
        ps.is_detected = data.get('is_detected', False)
        ps.similarity = data.get('similarity', 0.0)
        ps.bbox_area = data.get('bbox_area', 0)
    return ps


def main():
    parser = argparse.ArgumentParser(description="POSE MATCH 1V1 Demo")
    parser.add_argument("--camera", type=int, default=0, help="Camera index")
    parser.add_argument("--pose-cache", type=str, default="data/poses_cache.json",
                        help="Path to poses cache JSON")
    args = parser.parse_args()

    # Initialize pygame
    screen = init_pygame()
    renderer = Renderer(*screen.get_size(), screen=screen)

    # Initialize game state
    game_state = GameStateFSM()
    frame_packet = FramePacket()

    # Load pose targets from cache if exists
    poses_cache_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), args.pose_cache)
    pose_targets = []
    if os.path.exists(poses_cache_path):
        import json
        with open(poses_cache_path, 'r') as f:
            cache_data = json.load(f)
        raw_poses = cache_data.get("poses", {})
        # Normalize dict-of-pose or list-of-pose into a list
        if isinstance(raw_poses, dict):
            pose_targets = list(raw_poses.values())
        elif isinstance(raw_poses, list):
            pose_targets = raw_poses
        game_state.pose_targets = pose_targets
        print(f"Loaded {len(game_state.pose_targets)} pose targets from cache")
    else:
        print(f"Warning: pose cache not found at {poses_cache_path}")

    # Initialize vision worker
    vision_worker = VisionWorker(camera_index=args.camera)
    vision_worker.start()

    # Main loop variables
    clock = pygame.time.Clock()
    running = True
    last_time = time.time()
    debug_enabled = DEBUG_MODE

    print("=== POSE MATCH 1V1 Demo ===")
    print("Controls:")
    print("  SPACE - Force Pause/Resume")
    print("  R - Reset game")
    print("  ESC - Quit")
    print()

    try:
        while running:
            dt = time.time() - last_time
            last_time = time.time()
            dt = min(dt, 1.0 / 30.0)  # Cap delta time

            # Handle events
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    running = False
                elif event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_ESCAPE:
                        running = False
                    elif event.key == pygame.K_r:
                        game_state = GameStateFSM()
                        game_state.pose_targets = pose_targets
                        print("Game reset to IDLE")
                    elif event.key == pygame.K_SPACE:
                        # Toggle pause logic handled in FSM
                        if game_state.state == "PLAYING":
                            game_state.state = "PAUSED"
                            game_state.pause_timer = 3.0
                            game_state.manual_pause = True
                            print("Paused (manual)")
                        elif game_state.state == "PAUSED" and game_state.manual_pause:
                            game_state.state = "PLAYING"
                            game_state.manual_pause = False
                            print("Resumed (manual)")
                    elif event.key == pygame.K_d:
                        debug_enabled = not debug_enabled
                        print(f"Debug mode: {debug_enabled}")

            # Get latest frame from vision worker
            packet = vision_worker.get_latest_frame()
            if packet and 'shutdown' not in str(packet):
                frame_packet.frame = packet['frame']

                # Extract player data
                left_data = packet['left']
                right_data = packet['right']

                # Compute joint angles and similarity (scoring handled in GameStateFSM)
                def _update_player(data):
                    if not data or not data.get('is_detected'):
                        return
                    angles = joint_angles(data['landmarks_raw'])
                    data['angles'] = angles
                    target = game_state.current_target()
                    if target:
                        tvec = target.get('target_vector', [])
                        sim = pose_match_similarity(angles, tvec[:len(angles)])
                        data['similarity'] = sim

                try:
                    _update_player(left_data)
                except Exception as e:
                    print(f"Left angle calculation error: {e}")

                try:
                    _update_player(right_data)
                except Exception as e:
                    print(f"Right angle calculation error: {e}")

                # Update player states in frame packet (convert dicts to PlayerState)
                frame_packet.player_left = dict_to_player_state(left_data)
                frame_packet.player_right = dict_to_player_state(right_data)
                frame_packet.timestamp = packet.get('timestamp', time.time())

            # Update game state FSM
            game_state.update(frame_packet, dt)

            # Render
            renderer.render(frame_packet, game_state, debug_enabled)

            # Clock tick
            clock.tick(60)

    except KeyboardInterrupt:
        print("\nInterrupted by user")

    finally:
        vision_worker.stop()
        vision_worker.join(timeout=3)
        quit_pygame()
        print("Demo ended.")


if __name__ == "__main__":
    main()
