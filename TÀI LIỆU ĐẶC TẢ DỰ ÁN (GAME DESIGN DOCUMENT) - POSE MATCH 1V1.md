# GGD

# **TÀI LIỆU ĐẶC TẢ DỰ ÁN (GDD & TDD)**

**Dự án:** POSE MATCH 1V1

**Mục đích:** Minigame tương tác đối kháng 1v1 qua camera dành cho sự kiện / booth triển lãm.

### **1\. Kiến trúc Nền tảng (Tech Stack & Concurrency)**

* **Ngôn ngữ:** Python 3.10+  
* **Frameworks & Thư viện:**  
  * **OpenCV:** Đọc/ghi luồng camera, xử lý tiền kỳ frame.  
  * **Pygame:** Game loop, render UI/VFX 2D, phát SFX/BGM (khóa cứng 60 FPS).  
  * **MediaPipe Tasks API:** Pose Landmark Detection.  
* **Kiến trúc Đa luồng (Threading Architecture):**  
  * **Thread 1 (Vision Worker):** Đọc frame camera liên tục \-\> Mirror frame (lật ngang tạo hiệu ứng gương) \-\> Chạy MediaPipe Pose \-\> Chuẩn hóa landmarks \-\> Ghi đè kết quả vào `queue.Queue(maxsize=1)`.  
  * **Thread 2 (Main/Game Engine):** Đọc dữ liệu mới nhất từ queue \-\> Xử lý Game Logic (FSM, tính điểm, timer) \-\> Render đồ họa và âm thanh bằng Pygame.  
* **Lưu trữ Dữ liệu:**  
  * In-memory (RAM) cho từng phiên chơi.  
  * Tệp `config.json` cấu hình: thời gian ván đấu, ngưỡng tương đồng, timeout và đường dẫn tài nguyên (assets).

### **2\. Thuật toán Xử lý Tư thế (Pose Processing Pipeline)**

#### **a. Xử lý Nhiễu & Tách Người chơi Chính**

* Chia frame hiển thị thành 2 nửa độc lập: Vùng Trái (P1) và Vùng Phải (P2).  
* Tại mỗi nửa màn hình: Tính diện tích Bounding Box của tất cả người được nhận diện. Chỉ giữ lại người có diện tích lớn nhất (vị trí gần camera nhất), tự động lọc bỏ người đứng phía sau.

#### **b. Chuẩn hóa Tọa độ Khung xương (Landmarks Normalization)**

Không sử dụng tọa độ pixel tuyệt đối nhằm triệt tiêu sai số vị trí và vóc dáng:

* **Tâm gốc:** Điểm giữa 2 khớp hông:  
  `MidHip = (LeftHip + RightHip) / 2`  
* **Dịch tâm:** Toàn bộ 33 điểm được trừ cho tọa độ gốc:  
  `P_norm = P - MidHip`  
* **Khử sai số tỷ lệ (Scale Normalization):** Chia toàn bộ tọa độ cho khoảng cách 2 vai (`D_shoulders`) để loại bỏ khác biệt về chiều cao và cự ly đứng.

#### **c. Cơ chế So khớp (Pose Matching)**

* **Phương pháp:** Trích xuất vector góc giữa các cụm khớp xương chính (vai \- khuỷu \- cổ tay, hông \- gối \- cổ chân). So khớp vector góc người chơi với vector góc từ ảnh mẫu (sử dụng Cosine Similarity / Procrustes Analysis).  
* **Ưu điểm:** Cho phép bổ sung/thay thế thế mẫu bằng file ảnh thông thường mà không cần thu thập dữ liệu huấn luyện lại mô hình phân lớp.  
* **Ngưỡng chốt điểm:** Độ tương đồng đạt từ **85% trở lên** và duy trì liên tục trong **0.4 giây** (\~12 frames liên tiếp) để tránh nhận diện hành vi vung tay ngẫu nhiên.

### **3\. Quy tắc Gameplay & Logic Trận đấu (Game Rules)**

#### **a. Máy trạng thái hữu hạn (Finite State Machine \- FSM)**

* **STATE\_IDLE:** Màn hình chờ, hiển thị dòng nhắc "2 người chơi bước vào khung hình".  
* **STATE\_COUNTDOWN:** Khi hệ thống phát hiện đủ 2 người chơi hợp lệ ổn định trong 2 giây \-\> Kích hoạt đếm ngược 3, 2, 1 \-\> Vào trận.  
* **STATE\_PLAYING:** Ván đấu chính thức diễn ra trong vòng 30 giây.  
* **STATE\_PAUSED:** Nếu mất dấu người chơi quá 1.5 giây \-\> Đóng băng đồng hồ, hiển thị cảnh báo "Vui lòng trở lại vị trí". Tự động tiếp tục khi đủ 2 người.  
* **STATE\_GAME\_OVER:** Hết thời gian \-\> Công bố người chiến thắng, giữ màn hình tổng kết 5 giây \-\> Tự động chuyển về `STATE_IDLE`.

#### **b. Cơ chế Tranh điểm & Chuyển Pose**

* **Ưu tiên tốc độ:** Người đầu tiên đạt mốc 85% và giữ đủ 0.4s nhận ngay **\+1 Điểm**. Hệ thống lập tức tải pose tiếp theo cho cả 2 bên.  
* **Trường hợp đồng thời:** Nếu cả hai người cùng đạt chuẩn trong khoảng chênh lệch dưới **0.1 giây**, cả hai đều được cộng 1 điểm trước khi chuyển pose.  
* **Cơ chế chống nghẽn (Pose Timeout):** Giới hạn tối đa **7 giây/pose**. Quá thời gian mà chưa ai hoàn thành, hệ thống phát cảnh báo và chuyển sang pose kế tiếp (không tính điểm).

### **4\. Thiết kế Giao diện & Hiệu ứng (UI/UX)**

#### **a. Bố cục Hiển thị (Độ phân giải 1920x1080)**

* **Top Bar:** Logo 2 góc, đồng hồ đếm ngược đặt chính giữa kèm thanh tiến trình (progress bar) co ngắn dần.  
* **Split-Screen:**  
  * Nửa trái: P1 (chủ đạo Xanh lam), bảng điểm lớn ở góc trên.  
  * Nửa phải: P2 (chủ đạo Đỏ cam), bảng điểm lớn ở góc trên.  
* **Center Overlay:** Cửa sổ bán trong suốt hiển thị ảnh Pose mẫu ở vị trí trung tâm, có hiệu ứng trượt (slide-in) khi đổi pose.

#### **b. Phản hồi Thị giác (Visual Feedback)**

* **Màu khung xương (Skeleton):**  
  * Mặc định: Màu Trắng.  
  * Độ khớp 70% \- 84%: Chuyển màu Vàng (sắp đạt).  
  * Độ khớp \>= 85%: Chuyển màu Xanh lá (Green), xuất hiện vòng loading 0.4s quanh đầu.  
* **Hiệu ứng ăn điểm:** Hiệu ứng nảy số "+1" phóng to tại chỗ kèm viền màn hình bên ghi điểm chớp sáng.

#### **c. Phản hồi Âm thanh (Audio Feedback)**

* **BGM:** Nhạc nền điện tử tiết tấu nhanh lặp đoạn (loop).  
* **SFX:** Tiếng bíp đếm ngược 3-2-1, âm Ting chốt điểm, âm Whoosh chuyển pose, tiếng còi dài kết thúc trận đấu.

# TDD

# **TÀI LIỆU THIẾT KẾ KỸ THUẬT (TDD)**

**Dự án:** POSE MATCH 1V1

**Mục tiêu:** Kiến trúc hệ thống, cấu trúc dữ liệu và pipeline xử lý cho game booth tương tác thời gian thực.

### **1\. Kiến trúc Hệ thống & Luồng Dữ liệu (System Architecture)**

Hệ thống hoạt động theo mô hình Producer-Consumer không đồng bộ thông qua 2 luồng (Threads) độc lập nhằm duy trì FPS hiển thị và tránh nghẽn I/O từ camera.

\[Webcam Hardware\]  
       │  
       ▼ (cv2.VideoCapture)  
┌─────────────────────────────────────────────────────────────┐  
│ Thread 1: VisionWorker (Producer)                           │  
│ 1\. Đọc Raw Frame (1280x720 @ 30-60 FPS)                     │  
│ 2\. cv2.flip(frame, 1\) \-\> Hiệu ứng gương                     │  
│ 3\. MediaPipe Pose Tasks (RunningMode.IMAGE hoặc VIDEO)      │  
│ 4\. Lọc Bounding Box lớn nhất cho nửa Trái / Phải            │  
│ 5\. Trích xuất vector 8 góc khớp xương quan trọng            │  
└──────────────────────────────┬──────────────────────────────┘  
                               │  
                      queue.Queue(maxsize=1)  
                               │ (Ghi đè frame mới nhất, drop frame cũ)  
                               ▼  
┌─────────────────────────────────────────────────────────────┐  
│ Thread 2: Main / Pygame Engine (Consumer)                   │  
│ 1\. Lấy VisionData mới nhất từ Queue                         │  
│ 2\. So khớp Cosine Similarity với vector Pose mẫu            │  
│ 3\. Cập nhật FSM (Finite State Machine) & Timers             │  
│ 4\. Render UI, Skeleton, Animations, VFX ra màn hình         │  
│ 5\. Xử lý Input phím nóng quản trị & Âm thanh                │  
└─────────────────────────────────────────────────────────────┘

### **2\. Thuật toán So khớp Tư thế & Tiền xử lý (Pose Matching Pipeline)**

**2.1. Lọc khớp xương (Keypoints Selection)**

Bỏ qua các điểm khuôn mặt (0–10) và bàn chân chi tiết (29–32). Chỉ sử dụng 12 điểm cốt lõi:

* Vai: Left (11), Right (12)  
*   
* Khuỷu tay: Left (13), Right (14)  
*   
* Cổ tay: Left (15), Right (16)  
*   
* Hông: Left (23), Right (24)  
*   
* Đầu gối: Left (25), Right (26)  
*   
* Cổ chân: Left (27), Right (28)  
* 

**2.2. Vector hóa đặc trưng bằng Góc Khớp (Joint Angles)**

Để đảm bảo bất biến hoàn toàn với chiều cao, vị trí đứng và kích thước cơ thể, không so khớp tọa độ $(x, y)$ trực tiếp mà trích xuất **vector 8 góc 2D** $(\\theta\_1, \\theta\_2, ..., \\theta\_8)$:

* $\\theta\_1, \\theta\_2$: Góc khuỷu tay trái/phải $(\\angle\_{11,13,15}, \\angle\_{12,14,16})$.  
*   
* $\\theta\_3, \\theta\_4$: Góc nách/khớp vai trái/phải $(\\angle\_{23,11,13}, \\angle\_{24,12,14})$.  
*   
* $\\theta\_5, \\theta\_6$: Góc háng trái/phải $(\\angle\_{11,23,25}, \\angle\_{12,24,26})$.  
*   
* $\\theta\_7, \\theta\_8$: Góc đầu gối trái/phải $(\\angle\_{23,25,27}, \\angle\_{24,26,28})$.  
* 

Công thức tính góc giữa 3 điểm $A, B, C$ (với $B$ là đỉnh góc):

$$\\vec{u} \= A \- B, \\quad \\vec{v} \= C \- B$$  
$$\\theta \= \\arccos\\left(\\frac{\\vec{u} \\cdot \\vec{v}}{\\Vert{}\\vec{u}\\Vert{} \\Vert{}\\vec{v}\\Vert{} \+ \\epsilon}\\right) \\times \\frac{180^\\circ}{\\pi}$$  
**2.3. So khớp bằng Cosine Similarity**

So sánh vector góc hiện tại của người chơi $V\_{player} \\in \\mathbb{R}^8$ với vector mẫu $V\_{target} \\in \\mathbb{R}^8$:

$$\\text{Similarity}(V\_{player}, V\_{target}) \= \\frac{V\_{player} \\cdot V\_{target}}{\\Vert{}V\_{player}\\Vert{}\_2 \\cdot \\Vert{}V\_{target}\\Vert{}\_2}$$

* Nếu $\\text{Similarity} \\ge 0.88$: Ghi nhận đúng form (True).  
* 

### **3\. Cấu trúc Dữ liệu & State Machine**

**3.1. Cấu trúc Pose Cache (**data/poses\_cache.json**)**

Được tiền xử lý trước (offline) từ ảnh trong thư mục assets/poses/:

JSON  
{  
  "pose\_01": {  
    "image\_path": "assets/poses/pose\_01.png",  
    "target\_vector": \[165.2, 85.0, 45.1, 92.4, 175.0, 180.0, 170.5, 168.0\],  
    "difficulty": "easy"  
  }  
}

**3.2. Cấu trúc gói dữ liệu luồng (**VisionData**)**

Python  
class PlayerVisionData:  
  bounding\_box: tuple\[int, int, int, int\]  \# x, y, w, h  
  landmarks\_raw: list\[tuple\[float, float\]\]  \# 33 điểm chuẩn hóa cho việc vẽ  
  angles\_vector: list\[float\]  \# 8 góc khớp xương  
  is\_detected: bool

class FramePacket:  
  frame: np.ndarray  \# Frame ảnh OpenCV sau khi flip  
  player\_left: PlayerVisionData  
  player\_right: PlayerVisionData  
  timestamp: float

**3.3. Chi tiết các trạng thái (FSM)**

* IDLE: Quét camera. Nếu cả player\_left.is\_detected và player\_right.is\_detected liên tục trong 2.0s $\\rightarrow$ Chuyển sang COUNTDOWN.  
*   
* COUNTDOWN: Giữ frame, hiển thị đếm ngược 3 $\\rightarrow$ 2 $\\rightarrow$ 1 (1 giây/số). Hết 3 giây $\\rightarrow$ Chọn pose ngẫu nhiên $\\rightarrow$ Chuyển sang PLAYING.  
*   
* PLAYING:  
* 

  * Timer ván đấu: 30s đếm lùi.  
  *   
  * Timer pose hiện tại: 7s timeout (nếu hết 7s không ai đạt $\\rightarrow$ âm thanh timeout, bốc pose mới).  
  *   
  * Bộ đếm đúng form (hold\_timer): Nếu $\\text{Similarity} \\ge 0.88$, tăng hold\_timer \+= dt. Đạt $\\ge 0.4s \\rightarrow$ Ghi điểm, bốc pose mới, reset timer.  
  *   
  * Mất người chơi: Nếu 1 trong 2 biến mất $\> 1.5s \\rightarrow$ Chuyển sang PAUSED.  
  *   
* PAUSED: Đóng băng toàn bộ gameplay timer. Chờ đủ 2 người trong 1.5s $\\rightarrow$ Đếm ngược 3s $\\rightarrow$ Quay lại PLAYING.  
*   
* GAME\_OVER: Dừng bắt landmarks. Render bảng điểm chung cuộc, bắn hiệu ứng chúc mừng bên thắng. Giữ 5s $\\rightarrow$ Tự động reset về IDLE.  
* 

### **4\. Bảng điều khiển & Phím tắt Quản trị (Dev/Operator Controls)**

Hệ thống bắt trực tiếp sự kiện bàn phím từ Pygame:

* KEY\_r: Reset toàn bộ game về trạng thái IDLE.  
*   
* KEY\_SPACE: Force Pause/Resume ván đấu tức thời.  
*   
* KEY\_s: Force Skip (Bỏ qua pose hiện tại, bốc pose mới).  
*   
* KEY\_d: Toggle Debug Mode (Hiển thị bounding box, chỉ số FPS thực tế, vector góc và % similarity trực tiếp trên đầu người chơi).  
*   
* KEY\_f: Toggle Fullscreen / Windowed mode (1920x1080).  
*   
* KEY\_ESCAPE: Thoát ứng dụng an toàn (Release camera, giải phóng thread).

### **5\. Cấu trúc Mã nguồn Dự án**

Plaintext  
pose\_match\_1v1/  
├── assets/  
│   ├── fonts/  
│   │   └── Montserrat-Bold.ttf  
│   ├── poses/               \# Chứa ảnh gốc để render ra UI và extract data  
│   │   ├── pose\_01.png  
│   │   └── pose\_02.png  
│   └── sfx/  
│       ├── correct.wav  
│       ├── countdown.wav  
│       ├── timeout.wav  
│       └── victory.wav  
├── data/  
│   └── poses\_cache.json     \# Tệp data vector góc sau khi extract  
├── src/  
│   ├── \_\_init\_\_.py  
│   ├── config.py            \# Hằng số (SIMILARITY\_THRESH \= 0.88, HOLD\_DURATION \= 0.4, ...)  
│   ├── vision\_worker.py     \# Thread 1: Camera capture, MediaPipe inference, BBox filter  
│   ├── pose\_math.py         \# Hàm tính góc vector, Cosine similarity  
│   ├── game\_state.py        \# Logic FSM, Score, Timer, Event triggers  
│   └── renderer.py          \# Pygame drawing: Skeleton, UI overlay, text VFX  
├── extract\_poses.py         \# Script chạy 1 lần để quét /assets/poses \-\> tạo poses\_cache.json  
├── main.py                  \# Khởi tạo Thread, Game loop chính  
└── requirements.txt         \# opencv-python, mediapipe, pygame, numpy

### **6\. Kế hoạch Xử lý Rủi ro Hiệu năng (Performance Risk & Mitigation)**

| Vấn đề | Nguyên nhân | Giải pháp kỹ thuật |
| :---- | :---- | :---- |
| **Drop FPS hiển thị** | MediaPipe chạy chậm hơn tần số vẽ của Pygame. | Tách thread; queue.Queue(maxsize=1) đảm bảo Pygame không bao giờ đợi VisionWorker mà luôn lấy frame sẵn có. |
| **Treo camera (Camera freeze)** | Driver webcam bị ngắt kết nối hoặc mất frame. | Thêm timeout cv2.VideoCapture.read(). Nếu frame bị rỗng 5 lần liên tiếp $\\rightarrow$ Tự kích hoạt cap.release() và khởi tạo lại camera. |
| **Nhận diện sai khán giả** | Người đứng phía sau vô tình vung tay chuẩn form. | Chỉ so khớp landmarks của Pose có diện tích Bounding Box lớn nhất ($w \\times h$) ở mỗi nửa khung hình. |
| **Sai lệch góc do biến dạng ống kính (Lens Distortion)** | Camera góc rộng (Wide-angle) làm cong viền ảnh. | Giới hạn không gian chơi: Chỉ nhận pose khi Bounding Box nằm gọn trong khoảng $15\\% \- 85\\%$ chiều ngang của mỗi nửa khung hình. |

