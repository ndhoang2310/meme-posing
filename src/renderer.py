import math
import os
import sys

import cv2
import numpy as np
import pygame

from src.config import UPPER_BODY_ONLY


class Renderer:
    """Polished arcade HUD renderer for POSE MATCH 1V1."""

    WIDTH = 1920
    HEIGHT = 1080
    HEADER_H = 88
    FOOTER_H = 112
    MARGIN = 24

    BG_TOP = (11, 14, 32)
    BG_BOTTOM = (3, 5, 14)
    PANEL_BG = (12, 16, 34)
    PANEL_EDGE = (33, 40, 70)
    PANEL_EDGE_SOFT = (22, 28, 52)
    PANEL_GLOW = (54, 70, 120)
    WHITE = (240, 244, 252)
    DIM_WHITE = (165, 176, 200)
    MUTED = (122, 132, 160)
    P1 = (0, 229, 255)
    P1_DARK = (0, 116, 150)
    P2 = (255, 58, 112)
    P2_DARK = (150, 24, 68)
    GOLD = (255, 212, 66)
    GREEN = (66, 245, 119)
    YELLOW = (255, 214, 72)
    RED = (255, 84, 84)
    PURPLE = (168, 102, 255)

    def __init__(self, width=1920, height=1080, display_flags=0, screen=None):
        self.screen = screen or pygame.display.set_mode((width, height), display_flags)
        # Use the actual surface dimensions. SDL can report a different size
        # after entering fullscreen, especially on Retina/macOS displays.
        self.width, self.height = self.screen.get_size()
        pygame.display.set_caption("POSE MATCH 1V1 - Neon Arena")

        self._fonts = {}
        self._font_candidates = (
            "Montserrat",
            "Avenir Next",
            "Avenir",
            "Helvetica Neue",
            "Arial",
            "DejaVu Sans",
        )
        self._bg = self._make_background((width, height))
        self._header_bg = self._make_header_bg((width, self.HEADER_H))
        self._target_img_cache = {}
        self._last_frame = None
        self._camera_cache_frame = None
        self._camera_surface_cache = {}
        self._previous_state = None
        self._playing_capture_count = 0

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _font_path(self, bold=False):
        for family in self._font_candidates:
            path = pygame.font.match_font(family, bold=bold)
            if path:
                return path
        return None

    def _font(self, size, bold=False):
        key = (size, bold)
        if key not in self._fonts:
            path = self._font_path(bold=bold)
            if path:
                self._fonts[key] = pygame.font.Font(path, size)
            else:
                self._fonts[key] = pygame.font.SysFont("arial", size, bold=bold)
        return self._fonts[key]

    def _text(self, text, size, color, bold=False):
        return self._font(size, bold).render(text, True, color)

    def _blit_text(self, surf, text, size, color, center=None, topleft=None,
                   glow_color=None, glow=0, bold=False):
        img = self._text(text, size, color, bold)
        rect = img.get_rect()
        if center is not None:
            rect.center = center
        if topleft is not None:
            rect.topleft = topleft
        if glow_color and glow > 0:
            gimg = self._text(text, size, glow_color, bold)
            for off in range(glow, 0, -1):
                alpha = max(24, 80 - off * 10)
                gimg.set_alpha(alpha)
                for dx, dy in ((off, 0), (-off, 0), (0, off), (0, -off)):
                    surf.blit(gimg, rect.move(dx, dy))
        surf.blit(img, rect)
        return rect

    def _make_gradient(self, size, top, bottom):
        surf = pygame.Surface(size)
        h = size[1]
        for y in range(h):
            t = y / max(1, h - 1)
            c = (
                int(top[0] + (bottom[0] - top[0]) * t),
                int(top[1] + (bottom[1] - top[1]) * t),
                int(top[2] + (bottom[2] - top[2]) * t),
            )
            pygame.draw.line(surf, c, (0, y), (size[0], y))
        return surf.convert()

    def _make_background(self, size):
        surf = self._make_gradient(size, self.BG_TOP, self.BG_BOTTOM)
        overlay = pygame.Surface(size, pygame.SRCALPHA)
        w, h = size
        for x in range(0, w, 96):
            pygame.draw.line(overlay, (120, 150, 220, 12), (x, 0), (x, h), 1)
        for y in range(0, h, 96):
            pygame.draw.line(overlay, (120, 150, 220, 10), (0, y), (w, y), 1)
        pygame.draw.rect(overlay, (255, 255, 255, 20), (0, 0, w, h), width=2)
        self._draw_vignette(overlay)
        surf.blit(overlay, (0, 0))
        return surf

    def _make_header_bg(self, size):
        surf = self._make_gradient(size, (17, 22, 46), (8, 10, 23))
        overlay = pygame.Surface(size, pygame.SRCALPHA)
        w, h = size
        pygame.draw.line(overlay, (90, 120, 180, 40), (0, h - 1), (w, h - 1), 2)
        pygame.draw.line(overlay, (0, 229, 255, 18), (0, 2), (w, 2), 1)
        self._draw_vignette(overlay, center_y=h // 2, strength=0.45)
        surf.blit(overlay, (0, 0))
        return surf

    def _draw_vignette(self, surf, center_y=None, strength=1.0):
        w, h = surf.get_size()
        cx = w // 2
        cy = h // 2 if center_y is None else center_y
        for i in range(18):
            pad = i * 12
            alpha = int((14 - i * 0.65) * strength)
            if alpha <= 0:
                continue
            pygame.draw.rect(
                surf,
                (0, 0, 0, alpha),
                (pad, pad // 2, w - pad * 2, h - pad),
                width=2,
                border_radius=max(0, 28 - i),
            )

    def _round_rect(self, surf, color, rect, radius=12, width=0):
        pygame.draw.rect(surf, color, rect, border_radius=radius, width=width)

    def _neon_box(self, surf, rect, edge, glow, radius=14, width=2):
        x, y, w, h = rect
        glow_surf = pygame.Surface((w + 24, h + 24), pygame.SRCALPHA)
        pygame.draw.rect(
            glow_surf,
            (*glow, 36),
            (12, 12, w, h),
            border_radius=radius + 8,
            width=0,
        )
        surf.blit(glow_surf, (x - 12, y - 12))
        self._round_rect(surf, edge, rect, radius=radius, width=width)

    def _pill(self, surf, rect, fill, edge=None, radius=999, alpha=None):
        x, y, w, h = rect
        if alpha is not None:
            base = pygame.Surface((w, h), pygame.SRCALPHA)
            base.fill((*fill, alpha))
            surf.blit(base, (x, y))
        else:
            self._round_rect(surf, fill, rect, radius=min(radius, h // 2))
        if edge:
            self._round_rect(surf, edge, rect, radius=min(radius, h // 2), width=1)

    def _draw_section_title(self, surf, title, subtitle, x, y, accent):
        self._blit_text(surf, title, 40, self.WHITE, topleft=(x, y), bold=True)
        self._blit_text(surf, subtitle, 18, accent, topleft=(x, y + 36), bold=True)

    def _draw_progress_bar(self, surf, rect, frac, fill, bg, height=None):
        x, y, w, h = rect
        h = h if height is None else height
        self._round_rect(surf, bg, (x, y, w, h), radius=h // 2)
        if frac > 0:
            filled_w = max(h, int(w * max(0.0, min(1.0, frac))))
            self._round_rect(surf, fill, (x, y, filled_w, h), radius=h // 2)

    def _sim_color(self, sim):
        if sim >= 0.88:
            return self.GREEN
        if sim >= 0.72:
            return self.YELLOW
        return self.RED

    # ------------------------------------------------------------------
    # Main render
    # ------------------------------------------------------------------
    def render(self, frame_packet, game_state, debug=False):
        self.screen.blit(self._bg, (0, 0))
        self._last_frame = frame_packet.frame

        left = frame_packet.player_left
        right = frame_packet.player_right

        self._draw_header(game_state)

        panel_w = (self.width - 3 * self.MARGIN) // 2
        panel_y = self.HEADER_H + self.MARGIN
        panel_h = self.height - self.HEADER_H - self.FOOTER_H - 2 * self.MARGIN

        self._draw_vision_panel(
            left,
            panel_x=self.MARGIN,
            panel_w=panel_w,
            panel_h=panel_h,
            panel_y=panel_y,
            side="left",
            game_state=game_state,
        )
        self._draw_vision_panel(
            right,
            panel_x=self.MARGIN + panel_w + self.MARGIN,
            panel_w=panel_w,
            panel_h=panel_h,
            panel_y=panel_y,
            side="right",
            game_state=game_state,
        )

        self._draw_target_card(game_state, panel_y)
        self._draw_footer(game_state)
        self._draw_state_overlay(game_state, left.is_detected, right.is_detected)

        if debug:
            self._draw_debug_info(frame_packet, game_state)

        pygame.display.flip()

        # Capture the first few PLAYING frames automatically. This is useful
        # for diagnosing display artifacts that disappear before a screenshot
        # can be taken manually, especially in fullscreen mode.
        entering_playing = (
            game_state.state == "PLAYING"
            and self._previous_state != "PLAYING"
        )
        if entering_playing:
            self._playing_capture_count = 3
        if self._playing_capture_count > 0:
            capture_path = os.path.abspath(
                f".pose_match_playing_{4 - self._playing_capture_count}.png"
            )
            try:
                pygame.image.save(self.screen, capture_path)
            except pygame.error as exc:
                print(f"Display capture failed: {exc}")
            self._playing_capture_count -= 1
        self._previous_state = game_state.state

    # ------------------------------------------------------------------
    # Header
    # ------------------------------------------------------------------
    def _draw_header(self, game_state):
        self.screen.blit(self._header_bg, (0, 0))

        self._draw_section_title(
            self.screen,
            "POSE MATCH",
            "1V1 NEON ARENA",
            self.MARGIN + 2,
            14,
            self.P1,
        )

        self._draw_timer(game_state)

        total = getattr(game_state, "MATCH_ROUNDS", 9)
        cur = min(total, getattr(game_state, "round_index", 0) + 1)
        x = self.width - self.MARGIN - 320
        y = 14
        self._blit_text(
            self.screen,
            "TARGET",
            18,
            self.GOLD,
            topleft=(x, y),
            bold=True,
        )
        self._blit_text(
            self.screen,
            f"{cur:02d}/{total:02d}" if total else "--/--",
            34,
            self.WHITE,
            topleft=(x, y + 18),
            bold=True,
        )
        if total:
            self._draw_progress_bar(
                self.screen,
                (x, y + 60, 280, 8),
                cur / max(1, total),
                self.GOLD,
                self.PANEL_EDGE,
            )

    def _draw_timer(self, game_state):
        cx, cy = self.width // 2, self.HEADER_H // 2
        radius = 30
        max_time = float(getattr(game_state, "GAME_DURATION", 54.0))
        frac = max(0.0, min(1.0, game_state.game_timer / max_time))
        pulse = 0.78 + 0.22 * math.sin(pygame.time.get_ticks() / 260.0)

        pygame.draw.circle(self.screen, self.PANEL_EDGE, (cx, cy), radius, 5)
        if frac > 0:
            start = -math.pi / 2
            end = start + frac * 2 * math.pi
            pygame.draw.arc(
                self.screen,
                self.GOLD,
                (cx - radius, cy - radius, radius * 2, radius * 2),
                start,
                end,
                5,
            )

        seconds = max(0, int(game_state.game_timer))
        color = self.RED if seconds <= 5 else self.WHITE
        glow = self.GOLD if seconds > 5 else self.RED
        self._blit_text(
            self.screen,
            f"{seconds:02d}",
            36,
            color,
            center=(cx, cy),
            glow_color=glow,
            glow=1 if pulse > 0.9 else 0,
            bold=True,
        )
        self._blit_text(
            self.screen,
            "TIME",
            14,
            self.DIM_WHITE,
            center=(cx, cy + 36),
            bold=True,
        )

    # ------------------------------------------------------------------
    # Vision panels
    # ------------------------------------------------------------------
    def _draw_vision_panel(self, player, panel_x, panel_w, panel_h, panel_y, side, game_state):
        accent = self.P1 if side == "left" else self.P2
        accent_dark = self.P1_DARK if side == "left" else self.P2_DARK
        label = "P1" if side == "left" else "P2"
        name = "PLAYER 1" if side == "left" else "PLAYER 2"

        outer = (panel_x, panel_y, panel_w, panel_h)
        self._neon_box(self.screen, outer, accent, accent_dark, radius=22, width=2)

        inner = (panel_x + 6, panel_y + 6, panel_w - 12, panel_h - 12)
        self._round_rect(self.screen, self.PANEL_BG, inner, radius=18)

        header_h = 54
        header_rect = (panel_x + 14, panel_y + 14, panel_w - 28, header_h)
        header_bg = pygame.Surface((header_rect[2], header_rect[3]), pygame.SRCALPHA)
        header_bg.fill((10, 13, 27, 170))
        self.screen.blit(header_bg, (header_rect[0], header_rect[1]))
        self._round_rect(self.screen, accent_dark, header_rect, radius=14, width=1)

        self._pill(
            self.screen,
            (panel_x + 20, panel_y + 20, 68, 30),
            accent,
            edge=None,
            alpha=16,
        )
        self._blit_text(
            self.screen,
            label,
            20,
            accent,
            center=(panel_x + 54, panel_y + 35),
            bold=True,
        )
        self._blit_text(
            self.screen,
            name,
            18,
            self.WHITE,
            topleft=(panel_x + 96, panel_y + 25),
            bold=True,
        )

        sim = player.similarity
        sim_color = self._sim_color(sim)
        sim_box = (panel_x + panel_w - 148, panel_y + 17, 126, 38)
        self._pill(self.screen, sim_box, (10, 14, 30), edge=sim_color, alpha=185)
        self._blit_text(
            self.screen,
            f"{sim:.0%}",
            20,
            sim_color,
            center=(sim_box[0] + sim_box[2] // 2, sim_box[1] + 25),
            bold=True,
        )
        self._blit_text(
            self.screen,
            "MATCH",
            10,
            self.DIM_WHITE,
            topleft=(sim_box[0] + 10, sim_box[1] + 4),
            bold=True,
        )

        # Camera frame sits below the top HUD strip, preserving the camera as the focal point.
        camera_rect = (
            panel_x + 14,
            panel_y + 72,
            panel_w - 28,
            panel_h - 86,
        )
        self._round_rect(self.screen, self.BG_BOTTOM, camera_rect, radius=18)

        frame = self._last_frame
        crop_x0, crop_w, frame_h = 0, 1280, 720
        if frame is not None:
            h, w = frame.shape[:2]
            mid_x = w // 2
            frame_h = h
            if side == "left":
                crop = frame[:, :mid_x]
                crop_x0, crop_w = 0, mid_x
            else:
                crop = frame[:, mid_x:]
                crop_x0, crop_w = mid_x, w - mid_x
            # The camera worker produces about 30 FPS while the HUD renders at
            # 60 FPS. Reusing the converted surface between camera frames keeps
            # the display cadence stable and avoids two expensive conversions
            # per render tick.
            if frame is not self._camera_cache_frame:
                self._camera_cache_frame = frame
                self._camera_surface_cache = {}
            frame_surf = self._camera_surface_cache.get(side)
            if frame_surf is None:
                crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
                crop_resized = cv2.resize(crop_rgb, (camera_rect[2], camera_rect[3]))
                frame_surf = pygame.surfarray.make_surface(np.transpose(crop_resized, (1, 0, 2)))
                self._camera_surface_cache[side] = frame_surf
            self.screen.blit(frame_surf, (camera_rect[0], camera_rect[1]))
        else:
            dim = pygame.Surface((camera_rect[2], camera_rect[3]), pygame.SRCALPHA)
            dim.fill((0, 0, 0, 180))
            self.screen.blit(dim, (camera_rect[0], camera_rect[1]))
            self._blit_text(
                self.screen,
                "NO CAMERA FEED",
                34,
                self.DIM_WHITE,
                center=(camera_rect[0] + camera_rect[2] // 2, camera_rect[1] + camera_rect[3] // 2),
                bold=True,
            )

        if player.is_detected and player.landmarks_raw:
            self.screen.set_clip(pygame.Rect(camera_rect))
            self._draw_skeleton(
                self.screen,
                player.landmarks_raw,
                accent,
                camera_rect[0],
                camera_rect[1],
                camera_rect[2],
                camera_rect[3],
                offset_x=crop_x0,
                crop_w=crop_w,
                frame_h=frame_h,
            )
            bbox = player.bounding_box
            if bbox[2] > 0 and bbox[3] > 0:
                bx = bbox[0] - crop_x0
                bw = bbox[2] * (camera_rect[2] / float(crop_w))
                bh = bbox[3] * (camera_rect[3] / float(frame_h))
                by = bbox[1] * (camera_rect[3] / float(frame_h))
                pygame.draw.rect(
                    self.screen,
                    accent,
                    (camera_rect[0] + bx, camera_rect[1] + by, bw, bh),
                    2,
                    border_radius=6,
                )
            self.screen.set_clip(None)
        else:
            dim = pygame.Surface((camera_rect[2], camera_rect[3]), pygame.SRCALPHA)
            dim.fill((0, 0, 0, 58))
            self.screen.blit(dim, (camera_rect[0], camera_rect[1]))
            self._blit_text(
                self.screen,
                "NO PLAYER IN FRAME",
                32,
                self.DIM_WHITE,
                center=(
                    camera_rect[0] + camera_rect[2] // 2,
                    camera_rect[1] + camera_rect[3] // 2,
                ),
                bold=True,
            )

        # Thin bottom info rail keeps score/feedback readable without stealing the stage.
        rail_rect = (panel_x + 14, panel_y + panel_h - 52, panel_w - 28, 36)
        rail_bg = pygame.Surface((rail_rect[2], rail_rect[3]), pygame.SRCALPHA)
        rail_bg.fill((8, 10, 20, 165))
        self.screen.blit(rail_bg, (rail_rect[0], rail_rect[1]))
        self._round_rect(self.screen, self.PANEL_EDGE_SOFT, rail_rect, radius=12, width=1)
        self._blit_text(
            self.screen,
            "SCORE",
            14,
            self.MUTED,
            topleft=(rail_rect[0] + 14, rail_rect[1] + 10),
            bold=True,
        )
        score_value = game_state.score["left"] if side == "left" else game_state.score["right"]
        self._blit_text(
            self.screen,
            f"{score_value:02d}",
            22,
            self.WHITE,
            topleft=(rail_rect[0] + 76, rail_rect[1] + 7),
            bold=True,
        )
        self._draw_progress_bar(
            self.screen,
            (rail_rect[0] + rail_rect[2] - 160, rail_rect[1] + 12, 136, 10),
            sim,
            sim_color,
            self.PANEL_EDGE,
        )

    def _draw_skeleton(self, surface, landmarks, color, surf_x, surf_y, surf_w, surf_h,
                       offset_x=0, crop_w=1280, frame_h=720):
        if UPPER_BODY_ONLY:
            connections = [
                (11, 13), (13, 15),
                (12, 14), (14, 16),
                (11, 23), (12, 24),
                (23, 24),
                (11, 12),
            ]
            key_indices = {11, 12, 13, 14, 15, 16, 23, 24}
        else:
            connections = [
                (11, 13), (13, 15),
                (12, 14), (14, 16),
                (11, 23), (23, 25), (25, 27),
                (12, 24), (24, 26), (26, 28),
                (23, 24),
                (11, 12),
            ]
            key_indices = {11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28}

        scale_x = surf_w / float(crop_w)
        scale_y = surf_h / float(frame_h)
        sample = landmarks[11] if len(landmarks) > 12 and landmarks[11] is not None else landmarks[0]
        if isinstance(sample, dict):
            sample_x, sample_y = sample.get("x", 0.0), sample.get("y", 0.0)
        else:
            sample_x, sample_y = sample[0], sample[1]
        is_normalized = max(sample_x, sample_y) <= 1.0
        points = [None] * 33

        for idx, lm in enumerate(landmarks):
            if idx not in key_indices:
                continue
            if isinstance(lm, dict):
                px, py = lm["x"], lm["y"]
            else:
                px, py = lm[0], lm[1]
            if is_normalized:
                px *= 1280.0
                py *= 720.0
            nx = surf_x + (px - offset_x) * scale_x
            ny = surf_y + py * scale_y
            points[idx] = (int(nx), int(ny))

        for p1_idx, p2_idx in connections:
            if points[p1_idx] and points[p2_idx]:
                pygame.draw.line(surface, color, points[p1_idx], points[p2_idx], 4)

        for idx in key_indices:
            if points[idx]:
                pygame.draw.circle(surface, color, points[idx], 6)
                pygame.draw.circle(surface, self.BG_BOTTOM, points[idx], 3)

    # ------------------------------------------------------------------
    # Target card
    # ------------------------------------------------------------------
    def _draw_target_card(self, game_state, panel_y):
        target_total = len(game_state.pose_targets)
        if target_total == 0:
            return

        target = game_state.current_target()
        if not target:
            return

        target_index = game_state.current_target_index
        round_total = getattr(game_state, "MATCH_ROUNDS", 9)
        round_number = min(round_total, getattr(game_state, "round_index", 0) + 1)
        cx = self.width // 2
        # Keep the target reference prominent, but place it below both player
        # headers so it never covers their names or match indicators.
        card_w, card_h = 300, 184
        x = cx - card_w // 2
        y = panel_y + 72

        pulse = 0.5 + 0.5 * math.sin(pygame.time.get_ticks() / 320.0)
        edge = (
            min(255, int(self.GOLD[0] * (0.78 + 0.22 * pulse))),
            min(255, int(self.GOLD[1] * (0.78 + 0.22 * pulse))),
            min(255, int(self.GOLD[2] * (0.78 + 0.22 * pulse))),
        )
        self._neon_box(self.screen, (x, y, card_w, card_h), edge, (88, 70, 8), radius=18, width=2)

        bg = pygame.Surface((card_w - 12, card_h - 12), pygame.SRCALPHA)
        bg.fill((8, 11, 22, 220))
        self.screen.blit(bg, (x + 6, y + 6))

        self._blit_text(self.screen, "MATCH THIS POSE", 19, self.WHITE,
                        topleft=(x + 14, y + 12), bold=True)

        # Image and details are arranged like a game-show target card rather than a heavy poster.
        img_rect = pygame.Rect(x + 14, y + 46, 112, 112)
        target_col = pygame.Rect(x + 142, y + 46, 144, 112)

        img_path = target.get("image_path", "")
        img = None
        if img_path and os.path.exists(img_path):
            if target_index not in self._target_img_cache:
                try:
                    self._target_img_cache[target_index] = pygame.image.load(img_path).convert_alpha()
                except Exception:
                    self._target_img_cache[target_index] = None
            img = self._target_img_cache.get(target_index)

        self._round_rect(self.screen, self.PANEL_EDGE_SOFT, img_rect, radius=14, width=1)
        if img:
            iw, ih = img.get_size()
            scale = min((img_rect.w - 10) / iw, (img_rect.h - 10) / ih)
            nw, nh = int(iw * scale), int(ih * scale)
            scaled = pygame.transform.smoothscale(img, (nw, nh))
            self.screen.blit(scaled, (img_rect.centerx - nw // 2, img_rect.centery - nh // 2))
        else:
            self._blit_text(
                self.screen,
                "NO IMAGE",
                16,
                self.DIM_WHITE,
                center=img_rect.center,
                bold=True,
            )

        diff = target.get("difficulty", "").upper()
        diff_color = self.GREEN if diff == "EASY" else self.YELLOW if diff == "MEDIUM" else self.RED
        self._blit_text(self.screen, diff if diff else "TARGET", 15, diff_color,
                        topleft=(target_col.x, target_col.y), bold=True)
        self._blit_text(
            self.screen,
            f"{round_number:02d}",
            34,
            self.GOLD,
            topleft=(target_col.x, target_col.y + 18),
            bold=True,
        )
        self._blit_text(
            self.screen,
            f"OF {round_total:02d}",
            15,
            self.DIM_WHITE,
            topleft=(target_col.x + 48, target_col.y + 25),
            bold=True,
        )
        self._blit_text(
            self.screen,
            "POSE REMAINING",
            12,
            self.MUTED,
            topleft=(target_col.x, target_col.y + 76),
            bold=True,
        )
        self._draw_progress_bar(
            self.screen,
            (target_col.x, target_col.y + 94, 132, 8),
            round_number / max(1, round_total),
            self.GOLD,
            self.PANEL_EDGE,
        )

    # ------------------------------------------------------------------
    # Footer scoreboard
    # ------------------------------------------------------------------
    def _draw_footer(self, game_state):
        fy = self.height - self.FOOTER_H
        footer_bg = pygame.Surface((self.width, self.FOOTER_H), pygame.SRCALPHA)
        footer_bg.fill((8, 10, 20, 220))
        self.screen.blit(footer_bg, (0, fy))
        pygame.draw.line(self.screen, self.PANEL_EDGE, (0, fy), (self.width, fy), 1)

        left_score = game_state.score["left"]
        right_score = game_state.score["right"]
        cx = self.width // 2

        left_card = (self.MARGIN, fy + 20, 280, 68)
        right_card = (self.width - self.MARGIN - 280, fy + 20, 280, 68)
        center_chip = (cx - 56, fy + 22, 112, 44)

        self._draw_score_card(left_card, "P1", "PLAYER 1", left_score, self.P1, self.P1_DARK)
        self._draw_score_card(right_card, "P2", "PLAYER 2", right_score, self.P2, self.P2_DARK)
        self._pill(self.screen, center_chip, (16, 20, 36), edge=self.GOLD, alpha=220)
        self._blit_text(
            self.screen,
            "VS",
            28,
            self.GOLD,
            center=(cx, fy + 44),
            bold=True,
        )

    def _draw_score_card(self, rect, short_label, long_label, score, accent, dark):
        x, y, w, h = rect
        base = pygame.Surface((w, h), pygame.SRCALPHA)
        base.fill((10, 13, 27, 188))
        self.screen.blit(base, (x, y))
        self._round_rect(self.screen, dark, rect, radius=16, width=1)
        self._pill(self.screen, (x + 12, y + 18, 50, 30), accent, alpha=18)
        self._blit_text(self.screen, short_label, 18, accent, center=(x + 37, y + 33), bold=True)
        self._blit_text(self.screen, long_label, 14, self.DIM_WHITE, topleft=(x + 72, y + 14), bold=True)
        self._blit_text(self.screen, f"{score:02d}", 34, self.WHITE, topleft=(x + 72, y + 32), bold=True)

    # ------------------------------------------------------------------
    # State overlays
    # ------------------------------------------------------------------
    def _draw_state_overlay(self, game_state, left_detected=False, right_detected=False):
        state = game_state.state
        cx, cy = self.width // 2, self.height // 2

        if state == "IDLE":
            self._draw_idle_overlay(game_state, cx, cy, left_detected, right_detected)
        elif state == "COUNTDOWN":
            n = min(3, max(0, math.ceil(game_state.countdown_timer)))
            self._draw_countdown_overlay(cx, cy, n)
        elif state == "PLAYING":
            self._draw_playing_hint(game_state, cx, cy)
        elif state == "PAUSED":
            self._draw_paused_overlay(cx, cy)
        elif state == "GAME_OVER":
            self._draw_game_over(game_state, cx, cy)

    def _draw_idle_overlay(self, game_state, cx, cy, left_detected, right_detected):
        dim = pygame.Surface((self.width, self.height), pygame.SRCALPHA)
        dim.fill((4, 6, 18, 120))
        self.screen.blit(dim, (0, 0))

        card = pygame.Rect(cx - 360, cy - 160, 720, 240)
        panel = pygame.Surface(card.size, pygame.SRCALPHA)
        panel.fill((8, 10, 20, 210))
        self.screen.blit(panel, card.topleft)
        self._round_rect(self.screen, self.PANEL_EDGE, card, radius=22, width=1)

        self._blit_text(
            self.screen,
            "GET IN FRAME",
            64,
            self.WHITE,
            center=(cx, cy - 86),
            glow_color=self.P1,
            glow=1,
            bold=True,
        )
        self._blit_text(
            self.screen,
            "Both players step in front of the camera to start the match.",
            28,
            self.DIM_WHITE,
            center=(cx, cy - 32),
        )
        self._draw_idle_box(cx - 252, cy + 20, 220, 92, "P1", left_detected, self.P1, self.P1_DARK)
        self._draw_idle_box(cx + 32, cy + 20, 220, 92, "P2", right_detected, self.P2, self.P2_DARK)

    def _draw_idle_box(self, x, y, w, h, label, detected, accent, dark):
        color = self.GREEN if detected else accent
        glow = (34, 110, 78) if detected else dark
        self._neon_box(self.screen, (x, y, w, h), color, glow, radius=16, width=2)
        self._pill(self.screen, (x + 16, y + 18, 56, 28), color, alpha=20)
        self._blit_text(self.screen, label, 20, color, center=(x + 44, y + 32), bold=True)
        self._blit_text(
            self.screen,
            "READY" if detected else "WAITING",
            28 if detected else 24,
            self.WHITE if detected else self.DIM_WHITE,
            topleft=(x + 16, y + 50),
            bold=True,
        )

    def _draw_countdown_overlay(self, cx, cy, n):
        pulse = 0.5 + 0.5 * math.sin(pygame.time.get_ticks() / 220.0)
        self._blit_text(
            self.screen,
            "GET READY",
            46,
            self.GOLD,
            center=(cx, cy - 132),
            glow_color=self.GOLD,
            glow=1,
            bold=True,
        )
        ring = pygame.Surface((320, 320), pygame.SRCALPHA)
        pygame.draw.circle(ring, (0, 0, 0, 96), (160, 160), 116)
        pygame.draw.circle(ring, (255, 255, 255, 20), (160, 160), 116, 5)
        self.screen.blit(ring, (cx - 160, cy - 160))
        if n > 0:
            color = self.WHITE
            glow = self.P1 if pulse > 0.5 else self.GOLD
            self._blit_text(
                self.screen,
                str(n),
                190,
                color,
                center=(cx, cy + 6),
                glow_color=glow,
                glow=2,
                bold=True,
            )
        else:
            self._blit_text(
                self.screen,
                "GO!",
                170,
                self.GREEN,
                center=(cx, cy + 6),
                glow_color=self.GREEN,
                glow=2,
                bold=True,
            )
        self._blit_text(
            self.screen,
            "Strike the pose.",
            28,
            self.DIM_WHITE,
            center=(cx, cy + 150),
            bold=True,
        )

    def _draw_playing_hint(self, game_state, cx, cy):
        from src.config import HOLD_DURATION

        left_hold = game_state.hold_timer.get("left", 0)
        right_hold = game_state.hold_timer.get("right", 0)
        if left_hold <= 0 and right_hold <= 0:
            return

        y_base = cy - 170
        bar_w, bar_h = 250, 14
        gap = 70

        if left_hold > 0:
            x = cx - gap - bar_w
            frac = min(1.0, left_hold / HOLD_DURATION)
            color = self.GREEN if frac >= 1.0 else self.P1
            self._blit_text(
                self.screen,
                "P1 HOLDING",
                24,
                color,
                center=(x + bar_w // 2, y_base - 24),
                glow_color=color,
                glow=1,
                bold=True,
            )
            self._draw_progress_bar(self.screen, (x, y_base, bar_w, bar_h), frac, color, self.PANEL_EDGE)
            rem = max(0.0, HOLD_DURATION - left_hold)
            self._blit_text(self.screen, f"{rem:.1f}s", 20, self.WHITE, center=(x + bar_w // 2, y_base + 30))

        if right_hold > 0:
            x = cx + gap
            frac = min(1.0, right_hold / HOLD_DURATION)
            color = self.GREEN if frac >= 1.0 else self.P2
            self._blit_text(
                self.screen,
                "P2 HOLDING",
                24,
                color,
                center=(x + bar_w // 2, y_base - 24),
                glow_color=color,
                glow=1,
                bold=True,
            )
            self._draw_progress_bar(self.screen, (x, y_base, bar_w, bar_h), frac, color, self.PANEL_EDGE)
            rem = max(0.0, HOLD_DURATION - right_hold)
            self._blit_text(self.screen, f"{rem:.1f}s", 20, self.WHITE, center=(x + bar_w // 2, y_base + 30))

    def _draw_paused_overlay(self, cx, cy):
        dim = pygame.Surface((self.width, self.height), pygame.SRCALPHA)
        dim.fill((4, 6, 18, 92))
        self.screen.blit(dim, (0, 0))

        card = pygame.Rect(cx - 380, cy - 120, 760, 220)
        card_surf = pygame.Surface(card.size, pygame.SRCALPHA)
        card_surf.fill((8, 10, 20, 225))
        self.screen.blit(card_surf, card.topleft)
        self._round_rect(self.screen, self.YELLOW, card, radius=24, width=1)

        self._blit_text(
            self.screen,
            "PAUSED",
            72,
            self.YELLOW,
            center=(cx, cy - 44),
            glow_color=self.YELLOW,
            glow=2,
            bold=True,
        )
        self._blit_text(
            self.screen,
            "Players lost - get back in frame to continue.",
            28,
            self.DIM_WHITE,
            center=(cx, cy + 14),
        )
        self._pill(self.screen, (cx - 104, cy + 60, 208, 34), (18, 22, 40), edge=self.PANEL_EDGE, alpha=230)
        self._blit_text(
            self.screen,
            "CAMERA FEED STILL ACTIVE",
            16,
            self.WHITE,
            center=(cx, cy + 77),
            bold=True,
        )

    def _draw_game_over(self, game_state, cx, cy):
        ls, rs = game_state.score["left"], game_state.score["right"]
        if ls > rs:
            title, tcol = "P1 WIN", self.P1
            subtitle = "PLAYER 1 TAKES THE MATCH"
        elif rs > ls:
            title, tcol = "P2 WIN", self.P2
            subtitle = "PLAYER 2 TAKES THE MATCH"
        else:
            title, tcol = "DRAW", self.GOLD
            subtitle = "THE MATCH ENDS EVEN"

        # Full-screen result treatment makes the end of the nine-round match
        # unmistakable and keeps the winner label readable from a distance.
        result = pygame.Surface((self.width, self.height), pygame.SRCALPHA)
        result.fill((4, 6, 18, 255))
        for y in range(self.height):
            alpha = int(20 * (1.0 - y / max(1, self.height)))
            pygame.draw.line(result, (*tcol, alpha), (0, y), (self.width, y))
        self.screen.blit(result, (0, 0))

        pygame.draw.line(self.screen, tcol, (cx - 300, cy - 150), (cx + 300, cy - 150), 2)
        pygame.draw.line(self.screen, tcol, (cx - 300, cy + 170), (cx + 300, cy + 170), 2)
        self._blit_text(self.screen, "GAME OVER", 42, self.DIM_WHITE,
                        center=(cx, cy - 116), bold=True)
        self._blit_text(self.screen, title, 112, tcol, center=(cx, cy - 34),
                        glow_color=tcol, glow=3, bold=True)
        self._blit_text(self.screen, subtitle, 24, self.WHITE,
                        center=(cx, cy + 55), bold=True)
        self._blit_text(self.screen, f"{ls:02d}  -  {rs:02d}", 92, self.WHITE,
                        center=(cx, cy + 116), glow_color=tcol, glow=1, bold=True)
        self._pill(self.screen, (cx - 142, cy + 196, 284, 42),
                   (14, 18, 34), edge=tcol, alpha=220)
        self._blit_text(self.screen, "PRESS R TO PLAY AGAIN", 20, self.DIM_WHITE,
                        center=(cx, cy + 217), bold=True)

    # ------------------------------------------------------------------
    # Debug
    # ------------------------------------------------------------------
    def _draw_debug_info(self, frame_packet, game_state):
        state_text = self._text(f"State: {game_state.state} | Pose: {game_state.pose_timer:.1f}s", 22, self.WHITE)
        self.screen.blit(state_text, (20, self.height - 196))

        left = frame_packet.player_left
        right = frame_packet.player_right
        hold_left = game_state.hold_timer.get("left", 0.0)
        hold_right = game_state.hold_timer.get("right", 0.0)
        self._blit_text(
            self.screen,
            f"P1: Detected={left.is_detected} Sim={left.similarity:.2f} Hold={hold_left:.2f}s",
            22,
            self.WHITE,
            topleft=(20, self.height - 170),
        )
        self._blit_text(
            self.screen,
            f"P2: Detected={right.is_detected} Sim={right.similarity:.2f} Hold={hold_right:.2f}s",
            22,
            self.WHITE,
            topleft=(20, self.height - 146),
        )


def init_pygame():
    """Initialize pygame and return display surface."""
    pygame.init()
    try:
        pygame.mixer.init(frequency=22050, size=-16, channels=2, buffer=512)
    except pygame.error:
        pass
    # Keep a stable logical surface and let SDL scale it to the monitor. This
    # avoids corrupted text blocks on Retina/fullscreen display surfaces.
    return pygame.display.set_mode(
        (Renderer.WIDTH, Renderer.HEIGHT),
        pygame.FULLSCREEN | pygame.SCALED,
    )


def quit_pygame():
    """Cleanly quit pygame."""
    pygame.quit()
    sys.exit()
