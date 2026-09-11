# Deploy POSE MATCH 1V1 trên máy booth (máy khác)

Máy booth chạy **bản web** (`web/`) — không cần Python. Bản Python
(`src/`) chỉ là fallback, hướng dẫn ở cuối.

## 1. Yêu cầu máy booth

| Thứ | Yêu cầu |
|---|---|
| OS | macOS 12+ hoặc Windows 10/11 (64-bit) |
| Browser | Chrome hoặc Edge bản mới (khuyến nghị Chrome Stable) |
| Node.js | 20+ (chỉ cần lúc cài/build lần đầu) — https://nodejs.org |
| Git | để clone repo |
| Webcam | 720p trở lên, đã cắm và nhận bởi OS |
| Mạng | cần Internet **1 lần** để `npm install`; sau đó chạy offline hoàn toàn (model + WASM + ảnh đều local) |

Kiểm tra nhanh sau khi cài:

```sh
node --version   # >= v20
git --version
```

## 2. Cài đặt (làm 1 lần)

```sh
git clone https://github.com/ndhoang2310/meme-posing.git
cd meme-posing
sh web/start-booth.sh
```

Script tự: `npm install` → `vite build` → serve tại
`http://localhost:8080`. Mở browser vào đúng URL đó.

> `localhost` được browser coi là secure context nên webcam chạy được
> **không cần HTTPS**. Chỉ khi host qua LAN/IP thì mới cần HTTPS.

## 3. Chạy sự kiện (mỗi lần mở booth)

```sh
cd meme-posing
sh web/start-booth.sh
```

Rồi mở Chrome chế độ kiosk (fullscreen + tự cho phép camera):

```sh
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --kiosk http://localhost:8080 --use-fake-ui-for-media-stream

# Windows (cmd)
chrome.exe --kiosk http://localhost:8080 --use-fake-ui-for-media-stream
```

Thoát kiosk: `Cmd+Q` (macOS) / `Alt+F4` (Windows).

## 4. Checklist trước giờ G (trên chính máy booth)

- [ ] Vào `http://localhost:8080`, nhấn **Bắt đầu**, browser hiện footage mirror.
- [ ] 2 người đứng 2 nửa khung hình → sau ~2s đếm 3-2-1 → vào lượt 1/9.
- [ ] Skeleton cyan (P1) / hồng (P2) bám đúng người, không lệch video.
- [ ] Bắt chước pose → % tăng, giữ ~0.4s → +1 điểm, đổi pose.
- [ ] Một người bước ra >1.5s → hiện “VUI LÒNG TRỞ LẠI VỊ TRÍ”.
- [ ] Hết 9 lượt → màn hình thắng/hòa → 5s sau tự về IDLE.
- [ ] `R` reset, `F` fullscreen hoạt động.
- [ ] Đèn sự kiện thực tế (không quá tối/backlight), khoảng cách 2–3m.

## 5. Sự cố thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| “Cần HTTPS để mở camera” | Đang mở qua IP/LAN — dùng `http://localhost:8080` trên chính máy booth, hoặc host HTTPS |
| “Không tìm thấy webcam” | Kiểm tra OS có nhận camera; đóng app khác đang giữ camera (Zoom/Teams) |
| Màn hình đen sau khi Bắt đầu | Camera bị app khác chiếm, hoặc quyền camera OS bị tắt (macOS: System Settings → Privacy → Camera) |
| Lag / % nhảy chậm | Đóng tab/app nặng khác; máy booth nên có GPU/CPU desktop thông thường là đủ |
| Game kẹt ở màn hình loading / Network toàn `304` | Cache cũ từ lần chạy trước — hard refresh: `Cmd+Shift+R` (macOS) / `Ctrl+F5` (Windows), hoặc mở tab ẩn danh. Từ bản fix này server đã tắt cache (`no-store`) nên lỗi không tái diễn |
| `Không khởi động được game` + `ModuleFactory not set.` | Bản build cũ (worker dạng module) — chạy lại `sh web/start-booth.sh` để tự rebuild (script đã tự detect source mới), rồi reload trang |
| Muốn build lại sau khi `git pull` | `cd web && npm run build`, rồi chạy lại script |

## 6. Deploy Cloudflare (web tĩnh cho máy client)

Ổn. Bản web mặc định dùng model **lite (5.7MB)** nên **vừa luôn giới hạn
25MB/file của Pages** — deploy thẳng, không cần R2. (Chỉ khi đổi lại model
full ~30MB qua `VITE_MODEL_URL` thì mới cần §6.1.)

### 6.1. R2 cho model full (chỉ khi dùng model full)

1. Cloudflare dashboard → **R2** → tạo bucket, ví dụ `pose-match-assets`.
2. Upload `web/public/models/pose_landmarker.task` (giữ nguyên tên file).
3. Mở public access: bucket → **Settings → Public access** → bật qua `r2.dev`
   subdomain hoặc custom domain, được URL dạng
   `https://pub-xxx.r2.dev/pose_landmarker.task`.
4. Thêm **CORS policy** cho bucket (cho phép Pages fetch model):
   ```json
   [
     {
       "AllowedOrigins": ["https://<ten-app>.pages.dev"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

### 6.2. Pages cho app

1. **Workers & Pages → Create → Pages → Connect to Git**, chọn repo.
2. Cấu hình build:
   | Mục | Giá trị |
   |---|---|
   | Root directory | `web` |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Biến môi trường | `VITE_MODEL_URL=https://pub-xxx.r2.dev/pose_landmarker.task` |
3. Deploy. File `public/_headers` trong repo tự set sẵn
   `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` cho mọi response
   (MediaPipe WASM bắt buộc).

> `VITE_MODEL_URL` được nhúng **lúc build** — đổi URL model thì phải
> **Retry deployment** lại. Không set thì mặc định dùng model lite
> `/models/pose_landmarker_lite.task` same-origin (offline OK).
> Muốn model full local: build với `VITE_MODEL_URL=/models/pose_landmarker.task`.

### 6.3. Yêu cầu máy client

- HTTPS (Pages có sẵn) → camera `getUserMedia` chạy được.
- Chrome/Edge bản mới + webcam + CPU desktop thông thường.
- Lần tải đầu ~35MB (model R2 + WASM) — sau đó browser cache.
- Muốn chạy **offline** thì vẫn dùng `sh web/start-booth.sh` trên máy booth.

## 7. Fallback: bản Python desktop (không khuyến nghị cho booth mới)

```sh
python3.9 -m venv venv
./venv/bin/pip install -r requirements.txt
./venv/bin/python src/main.py
```

- macOS lưu ý SDL duplicate (opencv 5.x vs pygame): xem `AGENTS.md`.
- GPU delegate MediaPipe chỉ hỗ trợ Ubuntu — luôn chạy CPU.
