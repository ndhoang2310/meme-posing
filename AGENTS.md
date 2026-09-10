# AGENTS.md — POSE MATCH 1V1

## Chạy
- `./venv/bin/python src/main.py` (game, cần camera)
- `./venv/bin/python test.py` (test camera đơn giản)
- Smoke test logic (không cần cam): `./venv/bin/python /var/folders/qk/pqrr2_7548q6v1r9mkn9c9nw0000gn/T/opencode/meme_smoke.py`

## Kiến trúc vision
- Split-frame: 2 `PoseLandmarker`, mỗi cái 1 nửa khung hình, `RunningMode.VIDEO`, `num_poses=1`, chạy song song 2 thread (`vision_worker.py`)
- Landmark trả về toạ độ **full-frame pixel** (nửa phải offset `+mid_x`) → renderer vẽ skeleton/bbox phải trừ offset nửa trái khi vẽ vào panel crop (renderer.py `_draw_skeleton` nhận `offset_x/crop_w/frame_h`)
- Player trái/phải = cố định theo instance, không theo thứ tự index/LEFT-RIGHT label
- Model: `assets/models/pose_landmarker.task` (fallback lite, legacy solutions, simulated)

## Chấm điểm
- 4 góc thân trên (elbow L/R + shoulder L/R, chấm biên `UPPER_BODY_ONLY=true` trong config.py — nu mai număi hip/knee) → cosine similarity vs `target_vector` în `data/poses_cache.json` (4 chiều, dict pose)
- Ngưỡng `SIMILARITY_THRESH = 0.88`, giữ pose `HOLD_DURATION = 0.4`s
- Scoring toàn bộ trong `GameStateFSM` (`_update_playing`); `main.py` chỉ tính angles/similarity — đừng thêm scoring ở main (tránh cộng điểm 2 lần)

## Lưu ý môi trường macOS
- **SDL duplicate:** `opencv-python 5.x` bundle ffmpeg `libavdevice → libSDL2` trùng với pygame's SDL2 → ObjC duplicate class warnings, có thể crash ngẫu nhiên. Đã fix bằng symlink `cv2/.dylibs/libSDL2-2.0.0.dylib → pygame/.dylibs/libSDL2-2.0.0.dylib` (bản gốc backup `.bak`). **Nếu pip reinstall opencv sẽ ghi đè — phải làm lại fix này.**
- GPU delegate của MediaPipe Tasks API chỉ hỗ trợ Ubuntu → luôn dùng CPU.