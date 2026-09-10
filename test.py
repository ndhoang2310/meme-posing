import cv2

# Khởi tạo camera (Dùng số 0 và ép dùng AVFoundation cho macOS)
cap = cv2.VideoCapture(0, cv2.CAP_AVFOUNDATION)

# Đặt tên cửa sổ hiển thị
window_name = "Pose Match - Camera Live"

# Cấu hình cửa sổ cho phép phóng to/thu nhỏ
cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)

# Nếu muốn bật chế độ TOÀN MÀN HÌNH (Fullscreen) ngay khi chạy, hãy bỏ dấu # ở dòng dưới:
# cv2.setWindowProperty(window_name, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)

print("Đang truyền hình ảnh... Nhấn phím 'q' trên bàn phím để thoát.")

while True:
    # Đọc từng khung hình từ camera
    ret, frame = cap.read()
    
    if not ret:
        print("Không nhận được tín hiệu camera!")
        break

    # BẮT BUỘC: Lật hình ảnh theo trục ngang (như soi gương) để người chơi dễ tương tác
    frame = cv2.flip(frame, 1)

    # Hiển thị khung hình lên cửa sổ
    cv2.imshow(window_name, frame)

    # Đợi 1ms, nếu người dùng nhấn phím 'q' thì thoát vòng lặp
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

# Giải phóng bộ nhớ camera và đóng tất cả cửa sổ
cap.release()
cv2.destroyAllWindows()