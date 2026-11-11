# TexTone — Chép lời và thuyết minh gần realtime (beta)

## Cài đặt và triển khai

1. Cài Modal CLI, đăng nhập và triển khai dịch vụ GPU:

   ```bash
   modal deploy realtime_speech.py
   ```

   Dịch vụ dùng Modal secret `chatterbox-api-key`, chứa `CHATTERBOX_API_KEY` trùng với cấu hình Resonance. Chế độ thuyết minh cần các endpoint Chatterbox và Viterbox đã triển khai.

2. Thêm cấu hình chỉ dành cho máy chủ vào `.env`:

   ```dotenv
   REALTIME_API_URL=https://<dia-chi-dich-vu-stt>.modal.run
   REALTIME_SESSION_SECRET=<chuoi-ngau-nhien-it-nhat-32-ky-tu>
   ```

   Dùng `openssl rand -hex 32` để tạo khóa. Hệ thống tái sử dụng cấu hình Clerk, PostgreSQL, `CHATTERBOX_API_KEY`, `CHATTERBOX_API_URL` và `VITERBOX_API_URL`. Không đưa các khóa này vào extension.

3. Cập nhật cơ sở dữ liệu và chạy ứng dụng:

   ```bash
   npx prisma migrate deploy
   npx prisma generate
   npm run dev
   ```

4. Với Chrome 116 trở lên, mở `chrome://extensions`, bật **Developer mode** và chọn **Load unpacked → thư mục extension/**. Tiện ích có tên **TexTone**.
5. Đăng nhập Resonance, chọn tổ chức, vào `/realtime`, chọn chế độ/ngôn ngữ/giọng đọc và tạo mã phiên.
6. Mở tab YouTube hoặc trang HTTP(S) đang phát âm thanh. Trong TexTone, nhập địa chỉ Resonance (ví dụ `http://localhost:3000`), dán mã phiên, chọn âm lượng gốc và bấm **Bắt đầu**. Cho phép kết nối tới địa chỉ máy chủ khi Chrome yêu cầu.
7. Bấm **Dừng** để ngừng thu âm, hủy HTTP request và dừng giọng đọc. Đóng popup vẫn tiếp tục thu âm; huy hiệu **LIVE** cho biết phiên đang chạy. Phiên hết hạn/bị thay thế/hết hạn mức sẽ dừng thu âm; lỗi tạm thời được tự thử lại có giới hạn.

Phiên có hiệu lực 15 phút và tối đa 300 đoạn được nhận xử lý (kể cả lần xử lý bị lỗi); chạm giới hạn nào trước sẽ phải tạo lại phiên. Tạo phiên mới sẽ thay thế phiên cũ của cùng tổ chức. **Sau khi tạo mã mới, phải dán lại mã vào extension**; mã lưu trong popup không tự cập nhật. Mỗi lần thay đổi ngôn ngữ/giọng đọc cần tạo lại phiên.

TexTone giữ tối đa 200 đoạn transcript gần nhất trong bộ nhớ phiên Chrome và cho phép xuất thành `textone-transcript.txt`. Bắt đầu thu mới sẽ thay thế transcript này. Máy chủ không lưu transcript hoặc âm thanh tạo ra.

## Kiến trúc và độ trễ

```text
tabCapture → offscreen AudioWorklet → PCM WAV → API Next.js
           → faster-whisper → EnViT5 → Chatterbox/Viterbox
           → phát giọng đọc trong extension
```

- `tabCapture` thu âm ở cấp tab, không phụ thuộc cấu trúc DOM hay API phụ đề của YouTube. Trang nội bộ Chrome, nội dung được bảo vệ và một số trình phát nhúng có thể không thu được. Extension không dùng microphone.
- Mỗi đoạn âm thanh dài 1–3 giây, định dạng mono PCM16, 16 kHz, có WAV header độc lập. Worklet kiểm tra RMS mỗi 10 ms, gửi sớm khi có khoảng nghỉ ít nhất 350 ms và đã thu tối thiểu 1 giây; lời nói liên tục vẫn chia ở 3 giây. Không tích lũy khoảng im lặng trước câu nói. Đoạn ngắn có thể dùng hết giới hạn 300 đoạn trước 15 phút.
- Client lọc im lặng theo RMS; máy chủ dùng Silero VAD để giảm suy luận không cần thiết. STT dùng faster-whisper; EnViT5 dịch Anh–Việt theo câu trên GPU. Cấu hình ưu tiên độ trễ; chất lượng trên âm thanh nhiễu và ranh giới câu vẫn cần đo thực tế.
- Mô hình được giữ trong bộ nhớ GPU khi container còn chạy; trọng số được lưu trên Modal volume. Container có thể tắt sau 5 phút không hoạt động. Request đầu tiên sau đó có thể timeout khi tải lại mô hình. Có thể cấu hình `min_containers=1` để giữ container sẵn sàng sau khi cân nhắc chi phí GPU; mặc định chưa bật.
- Mỗi client chỉ có một request đang xử lý và một đoạn chờ. Đoạn chờ cũ được thay bằng đoạn mới; đoạn chờ quá 4 giây bị bỏ qua. Giọng đọc mới có thể thay thế câu trước chưa phát xong để tránh tích lũy độ trễ.
- Luồng trực tiếp không tải audio lên R2 hoặc ghi lịch sử generation. Polar và yêu cầu thuê bao đã được bỏ khỏi luồng xử lý.
- Tra cứu giọng đọc chạy song song với STT/dịch, tránh thêm một lượt chờ cơ sở dữ liệu sau nhận dạng.
- Popup hiển thị thời gian request đi–về và độ trễ ước tính từ đầu đoạn (thu âm + chờ hàng đợi + request). API trả riêng thời gian STT/dịch và tổng thời gian máy chủ. Kiểm thử mô phỏng câu nói 600 ms + im lặng 400 ms gửi ở mốc 1 giây, giảm 2 giây chờ thu âm so với trước. Đây chưa phải benchmark GPU hoặc cam kết độ trễ đầu cuối trên production.

## Xác thực và giới hạn

| Cơ chế | Hành vi |
| --- | --- |
| Tạo phiên | Yêu cầu đăng nhập Clerk, tổ chức, POST cùng origin |
| Mã phiên HMAC | Gắn với tổ chức, người dùng, giọng đọc, chế độ và ngôn ngữ; hết hạn sau 15 phút |
| Lưu mã phiên | Chỉ giữ trong Chrome session storage; không chứa khóa mô hình |
| Giới hạn cơ sở dữ liệu | Một phiên cho mỗi tổ chức, một đoạn đang xử lý mỗi phiên, tối đa 300 đoạn |
| Khóa xử lý tạm thời | Thao tác DB nguyên tử, có thể phục hồi sau 120 giây nếu request bị gián đoạn; chỉ request sở hữu khóa mới được giải phóng khóa |
| Timeout dịch vụ | 105 giây cho chuỗi request tới các dịch vụ xử lý |
| Upload | Tối đa 1 MB; dịch vụ GPU kiểm tra WAV mono PCM16/16 kHz, dài tối đa 6 giây |
| Quyền extension | Chỉ xin quyền kết nối tới máy chủ người dùng chọn khi bắt đầu |

Mã phiên là thông tin cấp quyền tạm thời, không chia sẻ cho người khác. Thông tin phiên vẫn được lưu dù audio/transcript không được lưu trên máy chủ.

`/api/realtime/chunk` không dùng chuyển hướng đăng nhập Clerk, nhưng tự kiểm tra chữ ký mã phiên và trạng thái trong cơ sở dữ liệu trước khi chạy mô hình.

### Phân biệt lỗi phiên và phục hồi

Bản cũ trả chung `Session busy, revoked or exhausted` (429), khiến extension dừng ngay cả khi chỉ đang bận. Bản mới phân biệt:

| Mã lỗi | HTTP | Xử lý |
| --- | --- | --- |
| `SESSION_INVALID` / `SESSION_EXPIRED` | 401 | Tạo mã mới tại `/realtime` rồi dán lại |
| `SESSION_REVOKED` | 401 | Dán mã mới nhất; mã cũ bị thay thế khi tổ chức tạo phiên mới |
| `SESSION_EXHAUSTED` | 409 | Đã nhận xử lý 300 đoạn; tạo và dán mã mới |
| `SESSION_BUSY` | 429 | Giữ thu âm, chờ `Retry-After: 1`, tự thử lại với đoạn gần nhất; giới hạn khoảng 125 giây |

Lỗi mạng/timeout và HTTP 502/503/504 được thử lại tối đa 3 lần liên tiếp. Trong lúc chờ chỉ giữ một đoạn mới nhất; không gửi lại đoạn đã chờ quá 4 giây. Bấm Dừng hủy cả lịch thử lại. Cần cập nhật **cả API máy chủ và extension 0.1.1** để có đầy đủ phân loại lỗi; API cũ vẫn trả 429 chung nên extension chỉ có thể thử lại có giới hạn.

Bản beta yêu cầu chọn rõ nguồn tiếng Anh hoặc tiếng Việt. Đây là thuyết minh gần realtime theo đoạn; chưa có phiên dịch đồng thời, phụ đề khớp từng từ, đồng bộ video hoặc đồng bộ môi.

## Kiểm tra

Chạy tại thư mục gốc:

```bash
node --import tsx --test tests/realtime.test.ts tests/*.test.mjs
npx tsc --noEmit
npx eslint src/app/api/realtime 'src/app/(dashboard)/realtime' src/lib/realtime extension tests
python3 -c "import ast, pathlib; ast.parse(pathlib.Path('realtime_speech.py').read_text())"
npm run build
```

Nếu môi trường chỉ có SWC WASM, dùng `npm run build -- --webpack` thay cho build Turbopack mặc định.

Trước khi đưa vào sử dụng, kiểm thử với dịch vụ đã triển khai:

- Anh → Việt, Việt → Anh và chỉ chép lời.
- Tab im lặng, nội dung dài, đóng popup và đóng tab đang thu.
- Bấm Dừng khi request đang chạy.
- Mã phiên hết hạn, bị thay thế hoặc giọng đọc không còn khả dụng.
- Suy luận chậm và nhiều client cùng tổ chức.

Đo p50/p95 khi GPU khởi động lạnh và khi đã sẵn sàng; đánh giá độ chính xác trên các video đại diện. Việc tải image/mô hình GPU, migration và thu âm Chrome cần kiểm thử tích hợp trong môi trường triển khai.

## Tài liệu tham khảo

- [Thu âm Chrome và offscreen document](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)
- [faster-whisper và VAD](https://github.com/SYSTRAN/faster-whisper)
- [Thông tin mô hình EnViT5 Translation](https://huggingface.co/VietAI/envit5-translation)

## Extension 0.1.2 và phản hồi từng bước

Extension gửi `Accept: application/x-ndjson`; API trả tiến độ nhận dạng, transcript ngay khi STT/dịch hoàn tất, rồi mới trả audio. Client cũ vẫn nhận JSON. Nếu TTS lỗi, transcript được giữ và có cảnh báo. Popup phân biệt đang nhận dạng, đang sinh giọng, số đoạn thu/xử lý/phát/bỏ qua. Thời gian từ đầu đoạn hiện đo tới lúc nhận transcript, chưa gồm chờ TTS.

Viterbox và Chatterbox tuần tự hóa truy cập mô hình để tránh tranh chấp voice conditionals/decoder/VAD. API khởi động TTS qua health song song với STT; đoạn Viterbox realtime không chạy chia câu/VAD hậu xử lý. Cache model không loại bỏ hoàn toàn cold start. Cần kiểm thử video thật sau mỗi lần triển khai; xem trạng thái trong production-vercel.md.
