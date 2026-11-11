# Resonance · TexTone

Resonance là ứng dụng tạo giọng nói từ văn bản và quản lý giọng đọc. **TexTone**
là Chrome extension kết nối với Resonance để nhận dạng, dịch và phát thuyết minh
Anh–Việt theo timestamp của video YouTube.

## Chức năng

- Tạo giọng nói với Chatterbox và Viterbox, quản lý giọng mẫu và giọng tùy chỉnh.
- TexTone ưu tiên phụ đề YouTube đã dịch hoặc bản dịch tự động có timestamp, tạo
  giọng trước playhead rồi phát theo đồng hồ video. Video không có phụ đề phù hợp
  và các trang HTTP(S) khác tự chuyển sang luồng thu âm tab.
- Chuyển lời nói thành văn bản hoặc dịch và thuyết minh giữa tiếng Anh và tiếng Việt.
- Điều chỉnh âm lượng gốc, xem bản chép lời và tải tối đa 200 đoạn gần nhất thành tệp `.txt`.
- Quản lý truy cập theo tài khoản và tổ chức.

> TexTone đang ở bản beta. Bản 0.8.3 dịch trước tối đa 60 giây từ phụ đề, giữ ngữ
> cảnh câu dài tới 18 giây và chỉ phát video sau khi có 15 giây thuyết minh liên
> tục; chưa đồng bộ khẩu hình.

## Yêu cầu

- Node.js và npm tương thích với Next.js 16.
- PostgreSQL, tài khoản Clerk và Cloudflare R2 đã cấu hình cho ứng dụng.
- Các dịch vụ Chatterbox, Viterbox và STT/dịch trên Modal.
- Chrome 116 trở lên để sử dụng TexTone.

## Cài đặt ứng dụng

### 1. Cài thư viện

Tại thư mục gốc của dự án:

```bash
npm install
```
Open http://localhost:3000 in your browser to view the application.

### 2. Cấu hình môi trường

Tạo hoặc cập nhật `.env`. Không đưa khóa bí mật vào extension hoặc commit vào Git.

| Nhóm | Biến cấu hình |
| --- | --- |
| Ứng dụng | `APP_URL` (ví dụ `http://localhost:3000`) |
| Cơ sở dữ liệu | `DATABASE_URL` |
| Xác thực Clerk | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` |
| Lưu trữ R2 | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` |
| Tạo giọng nói | `CHATTERBOX_API_URL`, `CHATTERBOX_API_KEY`, `VITERBOX_API_URL` |
| TexTone | `REALTIME_API_URL`, `REALTIME_SESSION_SECRET` |

Hai biến dành cho TexTone:

```dotenv
REALTIME_API_URL=https://<dia-chi-dich-vu-stt>.modal.run
REALTIME_SESSION_SECRET=<chuoi-bi-mat-ngau-nhien-it-nhat-32-ky-tu>
```

Tạo khóa ngẫu nhiên bằng lệnh:

```bash
openssl rand -hex 32
```

### 3. Triển khai dịch vụ STT/dịch

Sau khi cài Modal CLI và đăng nhập tài khoản Modal, cấu hình secret `chatterbox-api-key` chứa `CHATTERBOX_API_KEY` trùng với máy chủ Resonance, rồi chạy:

```bash
modal deploy realtime_speech.py
```

Gán địa chỉ dịch vụ trả về cho `REALTIME_API_URL`. Chế độ thuyết minh còn cần hai endpoint Chatterbox/Viterbox đang hoạt động và giọng đọc có tệp mẫu trên R2.

### 4. Cập nhật cơ sở dữ liệu và chạy ứng dụng

```bash
npx prisma migrate deploy
npx prisma generate
npm run dev
```

Mở [http://localhost:3000](http://localhost:3000), đăng nhập và chọn tổ chức. Tạo phiên TexTone yêu cầu đăng nhập và chọn tổ chức; chưa tích hợp thanh toán.

## Cài Chrome extension TexTone

1. Mở `chrome://extensions` trong Chrome.
2. Bật **Developer mode / Chế độ dành cho nhà phát triển**.
3. Chọn **Load unpacked / Tải tiện ích đã giải nén**.
4. Chọn thư mục [`extension/`](extension/) của dự án, nơi chứa `manifest.json`.
5. Tiện ích xuất hiện với tên **TexTone**. Có thể ghim TexTone lên thanh công cụ để mở nhanh.

Tên TexTone đã được khai báo trong manifest của extension. Hướng dẫn này dùng bản cài cục bộ; dự án chưa được phát hành trên Chrome Web Store.

Nếu đã cài phiên bản trước, bấm **Reload / Tải lại** trên thẻ tiện ích tại `chrome://extensions` để cập nhật tên và giao diện.

## Sử dụng TexTone

1. Mở trang `/realtime` trong Resonance hoặc chọn **Realtime speech** ở thanh bên.
2. Chọn chế độ **Chỉ speech-to-text** hoặc **Dịch và thuyết minh**.
3. Chọn ngôn ngữ nguồn; nếu thuyết minh, chọn thêm ngôn ngữ đích và giọng đọc.
4. Bấm **Tạo mã phiên extension**, sau đó sao chép mã.
5. Chuyển sang một video YouTube công khai, không phải live, và mở TexTone.
6. Nhập địa chỉ Resonance, ví dụ `http://localhost:3000`, và dán mã phiên.
7. Chọn âm lượng gốc rồi bấm **Bắt đầu**. Cấp quyền kết nối tới máy chủ khi Chrome
   yêu cầu. Với video có phụ đề phù hợp, video sẽ tạm dừng ngắn để tạo trước giọng
   đọc rồi tự chạy lại cùng phần thuyết minh nếu trước đó đang phát.
8. Xem văn bản nhận dạng và bản dịch trong popup. Chọn **Tải transcript** để lưu tệp `textone-transcript.txt`.
9. Bấm **Dừng** để ngừng thu âm, hủy request đang chờ và dừng giọng đọc.

**Lưu ý khi dùng:**

- Đóng popup không dừng thu âm; huy hiệu **LIVE** trên biểu tượng cho biết phiên đang chạy.
- Phiên hết hạn sau 15 phút hoặc 300 đoạn xử lý. Tạo phiên mới sẽ thay thế phiên cũ của cùng tổ chức; cần dán lại mã mới vào extension.
- Thay đổi ngôn ngữ hoặc giọng đọc trên trang cấu hình cần tạo mã phiên mới.
- Bắt đầu lần thu mới sẽ thay thế transcript đang giữ trong extension.
- Với YouTube, extension đọc phụ đề trong chính tab đang mở, ưu tiên phụ đề đích
  có sẵn rồi dùng bản dịch tự động của YouTube. Phụ đề tiếng Anh do tác giả cung
  cấp được chọn trước track ASR. Chỉ văn bản và timestamp được gửi đến máy chủ để
  tạo giọng; extension không thêm thành phần vào giao diện YouTube.
- Pause dừng cả video và thuyết minh. Tua sẽ xóa giọng cũ, chuẩn bị lại tại vị trí
  mới rồi mới phát tiếp để không đọc nhầm câu.
- Nếu không có phụ đề phù hợp hoặc YouTube thay đổi định dạng phụ đề, extension tự
  thu âm tab và chạy STT/dịch như trước. Extension không dùng microphone; trang nội
  bộ Chrome không được hỗ trợ.

## Xử lý lỗi thường gặp

| Hiện tượng | Cách xử lý |
| --- | --- |
| `Realtime service is not configured` | Kiểm tra `REALTIME_API_URL` và `REALTIME_SESSION_SECRET` có ít nhất 32 ký tự; khởi động lại ứng dụng. |
| Phiên hết hạn, bị thay thế hoặc hết hạn mức | Tạo mã phiên mới tại `/realtime` và dán lại vào TexTone. |
| `Session busy, revoked or exhausted` | Thông báo chung của API cũ. Cập nhật API và extension 0.1.1 để phân biệt nguyên nhân. Nếu vừa tạo phiên mới, dán lại mã mới nhất vào popup. |
| Phiên đang bận / đang thử lại | Extension giữ thu âm và tự kết nối lại có giới hạn; chỉ giữ đoạn mới nhất để tránh tăng độ trễ. |
| Không có giọng đọc | Kiểm tra giọng mẫu hoặc giọng tùy chỉnh đã có tệp trên R2 và thuộc phạm vi truy cập của tổ chức. |
| Lần đầu xử lý lâu hoặc timeout | Dịch vụ GPU có thể đang khởi động và tải mô hình; kiểm tra log Modal rồi thử lại. |
| YouTube không cấp audio công khai | Cập nhật extension 0.8.3. Luồng phụ đề mới không yêu cầu máy chủ tải audio; nếu thiếu phụ đề, extension tự thu âm tab. |
| Thuyết minh dừng để chờ | Pipeline chưa có đủ clip liên tục phía trước; kiểm tra gateway, speech và fast-tts trên máy chủ. |
| Lỗi Turbopack với SWC WASM | Thử build bằng `npm run build -- --webpack`. |

## Kiểm tra và build

```bash
npm run check
python3 -m unittest discover -s tests/python -p 'test_*.py'
npm run build
```

Chạy bản production sau khi build thành công:

```bash
npm run start
```

## Cấu trúc hệ thống (System Design)

| Đường dẫn | Nội dung |
| --- | --- |
| [`src/app/`](src/app/) | Next.js App Router (routes `/text-to-speech`, `/voices`, `/realtime`, `/videos` và API `/api/realtime/*`, `/api/trpc/*`) |
| [`src/features/`](src/features/) | Kiến trúc phân tách theo miền chức năng (`dashboard`, `text-to-speech`, `voices`, `realtime`, `videos`) |
| [`src/lib/`](src/lib/) | Hạ tầng dùng chung (`db`, `env`, `r2`, `realtime/session`, `realtime/video-auth`) |
| [`services/realtime/`](services/realtime/) | Dịch vụ AI & Pipeline xử lý thời gian thực (`gateway/`, `speech/`, `media/`, `tts/`) |
| [`extension/`](extension/) | Chrome Extension TexTone 0.9.5 (`sessions/`, `audio/`, `content/`, `lib/`) |
| [`deploy/lan/`](deploy/lan/) | Cấu hình Docker Compose & script triển khai trực tiếp lên máy chủ LAN `192.168.1.198` |
| [`scripts/`](scripts/) | Công cụ phát triển (`dev/`), vận hành (`ops/`) và khởi tạo dữ liệu (`seed/`) |
| [`tests/`](tests/) | Bộ kiểm thử tự động (`api/`, `extension/`, `python/`) |
| [`prisma/`](prisma/) | Schema và migration cơ sở dữ liệu PostgreSQL |
| [`docs/`](docs/) | Tài liệu kiến trúc và vận hành |
