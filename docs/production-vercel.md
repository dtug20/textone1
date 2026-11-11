# Triển khai TexTone lên Vercel

## Sửa realtime ngày 23/09/2026 — đã promote, chờ xác nhận YouTube

- Nguyên nhân quan sát từ log: STT trả 200; Viterbox chạy các suy luận đồng thời, có `SIGSEGV` (exit 139) và tải Silero VAD đồng thời gây thiếu `hubconf.py`. Vercel trả 502/504; API cũ chỉ trả transcript sau TTS nên mất kết quả nhận dạng khi TTS lỗi.
- Đã deploy `viterbox_tts.py` và `chatterbox_tts.py`: max_inputs=1, khóa mô hình; Viterbox cache trọng số trên Modal volume, thêm health endpoint và tùy chọn không chia câu cho đoạn realtime. Không bật GPU thường trực.
- Viterbox kiểm thử thật: lần lạnh 109,583 ms; lần nóng 8,121 ms từ máy local (log máy chủ 3,10 s). WAV 24 kHz mono, nhận dạng ngược cho ra câu thử tương ứng. Không coi số đo này là benchmark YouTube.
- Extension Chrome `kchjpbbpeblngdhcoeebinapglfahlln` tải từ `~/resonance/extension` đã Reload lên 0.1.2.
- API mới trả NDJSON: progress → transcript → result/audio. TTS lỗi vẫn giữ transcript; hỗ trợ JSON cho client cũ. Ngân sách xử lý 105 s, lease 120 s; client timeout 115 s. Cold start vẫn có thể lâu.
- Đã phục hồi 203 tệp từ deployment production trước bằng Vercel API, kiểm tra SHA-1, ghép riêng realtime vào `/tmp/textone-live-source`. Không dùng repo Git cũ để ghi đè production.
- Deployment mới Ready: `dpl_C3Ngd8CZ18J2MVWfYZaCHqjiLRhb`, `https://textone1-a6ewpj3ti-dtug20s-projects.vercel.app`. Build, lint, 35 Node tests, TypeScript qua trên Vercel; không có pending migrations. Hai Python tests kiểm tra khóa mô hình cũng qua local.
- Deploy dùng `--prod --skip-domain`; CLI báo alias `textone1-dtug20s-projects.vercel.app`. **Đã promote trong lần tiếp tục sau smoke test.** Chưa kiểm thử Chrome/YouTube đầu cuối sau deploy.
- Lần tiếp tục đã chạy smoke test deployment mới: POST thiếu token trả HTTP 401 với `SESSION_INVALID`. Đã promote thành công `dpl_C3Ngd8CZ18J2MVWfYZaCHqjiLRhb` ngày 23/09/2026. Người dùng được hướng dẫn xác nhận video YouTube thật; chưa coi smoke test là chứng minh đầu cuối.

Tiếp tục: kiểm tra POST không token trả 401 trên deployment mới, kiểm tra stream với phiên hợp lệ và WAV có lời nói, promote đúng deployment sau khi đạt; tạo mã phiên mới trong UI, dán vào TexTone 0.1.2, chạy video YouTube, xác nhận transcript/bản dịch và bộ đếm phát tăng qua nhiều đoạn, rồi kiểm tra Dừng. Giữ secret và token khỏi log.

## Trạng thái trước bản sửa 23/09/2026

Deployment mới nhất `textone1-rcbcjrzsz-dtug20s-projects.vercel.app` đã Ready và promote thành công lên production (`dpl_8aKjmpCu4YFTfaM3fEfboo2WU1zD`). Bản này bổ sung xử lý lỗi player; bản trước là `dpl_438qnA6y35hUGDYk7nKiwa8X53fq`. Các mục lịch sử bên dưới mô tả trạng thái trước lần build này.

- Kiểm tra cấu hình Production đã qua (gồm cặp khóa Clerk live).
- Lint, 11 tests, TypeScript và build Next.js 16.3.5 đã qua trên Vercel.
- Prisma báo `No pending migrations to apply`.
- `https://textone.id.vn/realtime` chuyển tới form đăng nhập khi chưa có phiên live; form hiển thị Google/Apple/Facebook/email.
- POST `/api/realtime/chunk` không có token trả 401 JSON đúng dự kiến.
- Cần đăng nhập lại sau đổi Clerk instance. Tổ chức/tài khoản development không tự chuyển sang production; giọng tùy chỉnh gắn org cũ có thể không xuất hiện với org mới.
- Đã đăng nhập tài khoản live, tải thư viện giọng và tạo mã phiên realtime thành công. Chưa thử audio video thật trên bốn nền tảng.

### Kiểm thử trình duyệt ngày 18/09/2026

- Tạo phiên realtime với giọng Hien: thành công, UI hiển thị mã và thời hạn 15 phút.
- Thư viện giọng và tìm kiếm Hien: trả đúng giọng; custom voice của tổ chức hiển thị.
- Custom voice: mở form, gửi rỗng báo thiếu audio/tên đúng dự kiến. Chưa upload/record giọng mới.
- Nút Voice cloning ở sidebar chưa có hành động; dùng Voices → Custom voice để mở form.
- TTS tiếng Việt với giọng custom có sẵn: tạo được generation `cmu6hhu0y000004iev7upqr7s`, xuất hiện trong History. GET audio trả 200, WAV PCM16 mono 24 kHz, 3,14 giây, 150572 bytes.
- Playback/download qua Chrome chưa đạt: `ERR_BLOCKED_BY_CLIENT`; WaveSurfer báo Failed to fetch. GET và HEAD CDN với Origin production đều thiếu `Access-Control-Allow-Origin`.
- Đã sửa mã player để hiển thị lỗi thay vì Loading audio vô hạn, reset trạng thái khi đổi audio và vô hiệu hóa Play trước khi tải xong. `npm run check` qua lint, 11 tests và TypeScript. Bản sửa đã được promote; đã xác minh trực tiếp tại domain production: thông báo lỗi xuất hiện và nút Phát âm thanh bị vô hiệu hóa đúng dự kiến. Build và migration trên Vercel đều qua; lỗi CDN chưa được khắc phục bằng thay đổi này.
- Chưa đánh giá chất lượng nghe, tốc độ ổn định khi mô hình nóng, hoặc thu âm/tabCapture và thuyết minh trên video thật. Không suy diễn test mô phỏng thành kiểm chứng bốn nền tảng.

### Khắc phục CDN audio

Trong Cloudflare R2 → bucket chứa audio → Settings → CORS policy, ghép quyền đọc cho origin production vào policy hiện có (không ghi đè các origin cần thiết khác):

```json
[
  {
    "AllowedOrigins": ["https://textone.id.vn"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

Nếu media domain đi qua Worker, Worker cần trả các header CORS tương ứng. Khi có cache, purge các URL audio bị ảnh hưởng sau đổi policy. Kiểm tra GET với `Origin: https://textone.id.vn` phải có `Access-Control-Allow-Origin: https://textone.id.vn`. Tham khảo [Cloudflare R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).

Lỗi Chrome `ERR_BLOCKED_BY_CLIENT` là một dấu hiệu riêng: kiểm tra tiện ích/quy tắc chặn URL `media.textone.id.vn` và báo cáo chặn của chúng. Không cần tắt bảo vệ toàn bộ Chrome. Chưa xác định được thành phần nào đang chặn; sửa CORS chưa chứng minh sẽ giải quyết dấu hiệu này.

### Cấu hình phía người dùng

1. Đăng nhập tại `https://textone.id.vn/realtime`, chọn hoặc tạo tổ chức live nếu được yêu cầu.
2. Trong Chrome, tải lại extension TexTone và đặt máy chủ `https://textone.id.vn`.
3. Tạo mã phiên mới trên `/realtime`; mã cũ hết hạn sau 15 phút.
4. Mở tab video công khai đang phát tiếng, bấm TexTone → Bắt đầu; kiểm tra transcript, thuyết minh và Dừng.
5. Nếu OAuth lỗi domain/redirect, kiểm tra domain `textone.id.vn` và cấu hình nhà cung cấp đăng nhập trong đúng Clerk Production instance. Không dùng URL deployment ngẫu nhiên làm máy chủ extension.


## Project và mã nguồn

- Project: `dtug20s-projects/textone1`.
- Domain hiện tại: `https://textone.id.vn`.
- Repo production: `dtug20/textone1`, nhánh `main`.
- Workspace phát triển: `/Users/dotung/resonance` (remote `dtug20/resonance`).
- Checkout triển khai đã ghép: `/tmp/textone-production-review`.

Checkout triển khai giữ các sửa đổi production hiện có về giao diện, CDN và giới hạn tham số Viterbox. Không đẩy nguyên workspace `resonance` đè lên repo production. Checkout hiện có thay đổi chưa commit; cần lưu vào repo `textone1` trước khi dọn thư mục tạm hoặc triển khai các lần sau từ Git.

## Đã thực hiện

- Bỏ tích hợp Polar, kiểm tra thuê bao và giao diện thanh toán; giữ xác thực người dùng/tổ chức và giới hạn phiên realtime.
- Nâng Next.js và eslint-config-next lên 16.3.5, dùng Webpack cho dev/build.
- Build production của workspace đã thành công sau khi bỏ Polar.
- Checkout triển khai đã cài bằng `npm ci`, qua lint không warning, TypeScript và 11 tests.
- Ba endpoint GPU trả OpenAPI đúng (`/process`, `/generate`). STT thật xử lý WAV im lặng tổng hợp và trả HTTP 200 với transcript rỗng.
- Liên kết checkout triển khai với đúng project Vercel.
- Thêm `REALTIME_API_URL` và `REALTIME_SESSION_SECRET` vào môi trường Production trên Vercel.
- Bỏ `SKIP_ENV_VALIDATION` khỏi môi trường Production.
- Xóa các tệp cấu hình tạm đã tải. Vercel che secret bằng `[SENSITIVE]`; không có xác nhận độc lập các giá trị secret production từ máy local.

## Lịch sử trước deployment Ready (đã được cập nhật ở đầu tài liệu)

- Lệnh tạo deployment mới bị hệ thống duyệt tự động chặn do giới hạn sử dụng tài khoản; chưa có deployment mới hoặc thay đổi domain.
- Build trên Vercel, kiểm tra cấu hình production thực tế và migration database chưa chạy.
- Chưa kiểm thử đăng nhập, tạo phiên và thuyết minh đầu cuối trên bản mới tại domain production.
- Các test YouTube/Facebook/Instagram/TikTok là mô phỏng định tuyến thu âm, không phải kết quả thử video thật trên từng nền tảng.
- Audit còn 6 cảnh báo dependency (1 low, 5 high) ở công cụ phát triển/chuỗi Prisma; chưa xử lý bằng hạ major hoặc override thiếu kiểm chứng.

## Tiếp tục triển khai

Chạy từ checkout đã ghép, không từ workspace `resonance`:

```bash
cd /tmp/textone-production-review
npx vercel deploy --prod --skip-domain --yes
```

Lệnh tạo deployment dùng môi trường Production nhưng chưa gán domain chính. `vercel-build` kiểm tra cấu hình, lint/tests/TypeScript, build rồi chạy `prisma migrate deploy`. Migration vẫn thay đổi database production dù dùng `--skip-domain`; migration mới chỉ thêm bảng `RealtimeSession` và index. Nếu có migration pending khác hoặc lỗi lịch sử migration, cần xử lý trước khi phát hành, không dùng reset database.

Nếu bước kiểm tra cấu hình báo thiếu/sai biến, sửa trong Vercel Settings → Environment Variables → Production. Giữ secret trên Vercel, không đưa vào Git hoặc chat. Không bật lại `SKIP_ENV_VALIDATION` để né lỗi.

Khi deployment có trạng thái Ready, kiểm tra trước khi promote:

1. Trang đăng nhập, chọn tổ chức, thư viện giọng và TTS cũ vẫn hoạt động.
2. `/realtime` tạo được phiên không yêu cầu thanh toán.
3. API chunk không có token bị từ chối; token hết hạn/bị thay thế không gọi mô hình.
4. Extension thu âm, hiển thị transcript và phát bản dịch; Dừng hủy thu âm/phát.
5. Kiểm tra nội dung thử được phép dùng trên từng nền tảng. Không dùng tin nhắn riêng hoặc audio cá nhân làm mẫu.

Sau khi kiểm tra đạt, gán domain:

```bash
npx vercel promote <deployment-url>
```

Kiểm tra lại `https://textone.id.vn/realtime` và nhập `https://textone.id.vn` làm địa chỉ máy chủ trong TexTone. Clerk có thể cần cấu hình domain cho URL deployment riêng trước khi đăng nhập kiểm thử; không tắt xác thực để vượt qua lỗi domain.

## Ma trận xác minh nền tảng

| Nền tảng | Định tuyến URL (test mô phỏng) | Thu âm video thật + STT/dịch/TTS |
| --- | --- | --- |
| YouTube | Đạt | Chưa xác minh |
| Facebook/Reels | Đạt | Chưa xác minh |
| Instagram/Reels | Đạt | Chưa xác minh |
| TikTok | Đạt | Chưa xác minh |

TexTone thu âm tab bằng Chrome tabCapture, không phụ thuộc DOM hoặc API riêng từng nền tảng. Tab phải đang phát audio và người dùng phải bấm Bắt đầu. Nội dung DRM, hạn chế trình duyệt hoặc video bị tắt tiếng có thể không thu được. Chưa có subtitle overlay, đồng bộ môi hoặc đồng bộ seek/pause của video; đây là thuyết minh theo đoạn gần realtime.

## Kiểm tra lại cấu hình Clerk trên Vercel

Deployment `3TLDhXnkLTtKnjYm66jQJHJ9TzaE` đã chạy nhưng dừng ở kiểm tra cấu hình. Chẩn đoán không in secret xác nhận `CLERK_SECRET_KEY` được cấp cho build là khóa Development/test; `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` không đúng định dạng tiền tố live/test mong đợi. Cần lưu lại giá trị thực từ cùng Clerk Production instance vào đúng project/môi trường. Chưa chạy migration hoặc gán domain cho bản mới.
