# TexTone — Chrome extension

TexTone đọc phụ đề tiếng Anh có timestamp ngay trong tab YouTube, ghép các dòng
ASR thành câu hoàn chỉnh, dịch nguyên câu rồi tạo giọng theo đúng đồng hồ video.
Pipeline chuẩn bị trước tối đa 60 giây và chỉ bắt đầu phát khi có 15 giây timeline
liên tục, nên giọng đã sẵn sàng khi timestamp phụ đề xuất hiện.
Phụ đề đích có sẵn được ưu tiên; bản dịch tự động của YouTube là fallback khi GPU
dịch tạm thời không phản hồi. Extension chỉ hiển thị popup;
không chèn nút, lớp phủ hoặc thay giao diện trình phát.

## Cài đặt

1. Dùng Chrome 116 trở lên, mở `chrome://extensions`.
2. Bật **Developer mode / Chế độ dành cho nhà phát triển**.
3. Bấm **Load unpacked / Tải tiện ích đã giải nén**.
4. Chọn chính thư mục `extension/` chứa tệp `manifest.json` này.
5. Ghim **TexTone** lên thanh công cụ Chrome nếu muốn.

Đây là bản cài cục bộ, chưa phải bản phát hành trên Chrome Web Store. Khi cập nhật mã nguồn, bấm **Reload / Tải lại** tại trang quản lý tiện ích.

## Kết nối và sử dụng

1. Khởi chạy Resonance theo [README của dự án](../README.md).
2. Đăng nhập, chọn tổ chức và mở `/realtime`.
3. Chọn chế độ, ngôn ngữ và giọng đọc rồi bấm **Tạo mã phiên extension**.
4. Mở một video YouTube công khai, không phải live, sau đó bấm biểu tượng **TexTone**.
5. Nhập địa chỉ Resonance (`http://localhost:3000` khi chạy cục bộ; HTTPS khi dùng máy chủ), dán mã phiên và chọn âm lượng gốc.
6. Bấm **Bắt đầu** và cho phép TexTone kết nối tới địa chỉ máy chủ. Video tạm dừng
   để chuẩn bị 15 giây giọng từ phụ đề, rồi tự chạy tiếp nếu trước đó đang phát. Khi
   video không có phụ đề phù hợp, extension tự chuyển sang nghe âm thanh tab.
7. Xem bản chép lời/bản dịch trong popup; bấm **Tải transcript** để xuất tối đa 200 đoạn gần nhất thành `textone-transcript.txt`.
8. Bấm **Dừng** khi kết thúc.

Đóng popup vẫn tiếp tục xử lý âm thanh. Phiên có hạn dùng 15 phút hoặc 300 đoạn xử lý; tạo phiên mới sẽ thay thế phiên cũ của tổ chức. **Phải dán mã mới vào popup sau mỗi lần tạo phiên** vì extension vẫn lưu mã đã nhập trước đó. Nếu đổi cài đặt ngôn ngữ hoặc giọng đọc, hãy tạo lại mã phiên.

Khi pause, giọng đọc dừng cùng video. Khi tua, extension hủy âm thanh cũ, bắt đầu
chuẩn bị lại từ timestamp mới và chỉ tiếp tục hình khi phần thuyết minh tại đó đã
sẵn sàng. Khi báo mã hết hạn, bị thay thế hoặc hết 300 đoạn, tạo/dán mã mới rồi
bấm Bắt đầu.

## Quyền truy cập

| Quyền | Mục đích |
| --- | --- |
| `activeTab` | Làm việc với tab người dùng chọn khi mở tiện ích |
| `scripting` | Đọc player response và phụ đề trong tab YouTube; đồng bộ pause/seek |
| `tabCapture` | Fallback thu âm khi YouTube không có phụ đề phù hợp và cho trang HTTP(S) khác |
| `offscreen` | Duy trì kết nối pipeline khi đóng popup |
| `storage` | Giữ mã phiên và tối đa 200 đoạn transcript trong bộ nhớ phiên Chrome |
| Quyền tới địa chỉ máy chủ | Gửi âm thanh đến máy chủ Resonance mà bạn cấu hình |

Không nhập khóa API mô hình vào tiện ích. Mã phiên cấp quyền truy cập tạm thời nên
không chia sẻ cho người khác. Tệp transcript chỉ được tải về khi bạn chọn xuất.

## Giới hạn bản beta

- Luồng nhanh phụ thuộc dữ liệu phụ đề nội bộ của YouTube. Nếu thiếu hoặc định dạng
  thay đổi, extension tự fallback sang STT/dịch từ audio tab với độ trễ cao hơn.
- Đây là đồng bộ theo timestamp phụ đề, không phải lip-sync theo khẩu hình.
- Chỉ hỗ trợ nguồn/đích tiếng Anh và tiếng Việt.
- Nếu pipeline không giữ được phần đệm phía trước, video sẽ tạm dừng thay vì phát
  sai câu thuyết minh.
- Không thu microphone; trang nội bộ Chrome không được hỗ trợ.
- Máy chủ GPU khởi động lạnh có thể làm request đầu tiên bị timeout.

Xem [tài liệu kỹ thuật](../docs/realtime.md) để cấu hình dịch vụ và kiểm tra lỗi.
