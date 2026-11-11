# TexTone 0.3.4 — popup và trình phát YouTube gốc

## Nguyên nhân và bản sửa

Bản 0.2 dùng video đã ghi để phát trong một lớp phủ đặt trên YouTube. Cách này làm thay đổi giao diện trình phát và không đáp ứng yêu cầu chỉ dùng popup. Bản 0.3 xóa script lớp phủ, không thêm phần tử, CSS, nút hoặc video thay thế vào trang.

Luồng mới có hai giai đoạn, theo lựa chọn đã xác nhận:

1. **Chuẩn bị**: thu và dịch 30 giây, 2 phút hoặc 5 phút từ vị trí hiện tại. Tiếng gốc được phát qua bộ nghe trong offscreen trong bước này; GPU xử lý tuần tự, có giới hạn hàng đợi. Bước này có thể mất vài phút.
2. **Phát đồng bộ**: khi toàn bộ phần đã chọn được chuẩn bị, YouTube quay về điểm bắt đầu. Giọng WAV phát qua Audio không gắn vào DOM. Thời gian, trạng thái pause/seek/rate của chính video YouTube điều khiển giọng. Điều chỉnh tốc độ giọng theo thời lượng đoạn, giữ nguyên tốc độ video và giữ cao độ giọng.

Không cần GPU tiếp tục chạy để phát phần đã chuẩn bị; hết hạn token sau khi chuẩn bị không tự cắt phần đang nghe. Tua ngoài vùng đã dịch sẽ pause video và báo ở popup, không phát nhầm giọng.

## Cách kiểm tra

1. Vào `chrome://extensions`, Reload TexTone; kiểm tra phiên bản **0.3.4**. Tải lại tab YouTube để loại script cũ.
2. Tạo mã phiên Anh → Việt, giọng Lan ở `/realtime`.
3. Chờ hết quảng cáo; đặt video vào đoạn có lời nói. Mở popup, dán mã, chọn **30 giây**, bấm **Chuẩn bị bản dịch**.
4. Không có tab mới, lớp phủ hoặc nút mới trên YouTube. Trong bước chuẩn bị, video phát tiếng gốc và có thể tạm chờ GPU. Popup hiển thị tiến độ.
5. Khi xong, video tự quay về vị trí ban đầu và phát giọng dịch. Nếu Chrome chặn tự phát, bấm nút Phát gốc của YouTube.
6. Dùng nút tạm dừng, tiếp tục, tua trong phần đã chuẩn bị và đổi tốc độ ngay trên YouTube. Tiếng phải dừng/tiếp tục/chuyển vị trí theo video, không tiếp tục đọc câu ở vị trí cũ.
7. Tua ra ngoài vùng đã dịch: video dừng, popup báo chưa có bản dịch. Tua lại vùng đã dịch hoặc Dừng rồi chuẩn bị phiên mới.
8. Bấm Dừng trong popup. Nguồn thu và tiếng dịch dừng; âm lượng/trạng thái mute ban đầu được khôi phục.
9. Nếu bật lưu, xem lại phần đã thu ở `/videos`.

## Giới hạn và kiểm chứng

Đồng bộ theo đoạn ngắn không đồng nghĩa đồng bộ môi. Bản dịch có thể khác cấu trúc/thời lượng lời gốc. Nếu tốc độ giọng cần thiết nằm ngoài khoảng trình duyệt hỗ trợ, video tạm dừng và báo lỗi thay vì phát lệch. Không hỗ trợ DRM hoặc nguồn chặn captureStream.

Kiểm thử tự động kiểm tra: không chạm DOM khi chuẩn bị/phát; không mở tab mới; giọng bám đồng hồ video gốc; pause/seek/rate/stall; hàng đợi; API và quyền lưu video. Cần kiểm tra thực tế trên Chrome sau khi Reload. Không dùng kết quả unit test để khẳng định end-to-end đã hoạt động.

Chạy `npm run check` và `python3 -m unittest discover -s tests -p 'test_*.py'`.


## Tối ưu 0.3.1

- Thu tối đa một số đoạn có giới hạn ngay khi GPU đang warmup. Nhận dạng vẫn chờ `/ready`, không gửi nhiều lần để đánh thức model.
- Lưu trữ chạy nền, tối đa 3 upload đang chờ. Audio đã dịch được chuyển sang bộ đệm ngay. Khi lưu lỗi, popup báo riêng và tiếp tục giữ bản dịch để nghe; không khẳng định video đã được lưu thành công. Bấm Dừng sẽ hủy upload chưa hoàn tất.
- Không gửi bản ghi WebM/base64 qua message sang trang YouTube: trang chỉ cần audio và timestamp. Video chỉ đi tới API lưu khi bật lưu.
- ASR trả `speechStart`, `speechEnd` tương đối theo PCM và thời gian chờ khóa/ASR/dịch. Extension chuyển các mốc này sang timeline video, giữ khoảng im lặng đầu/cuối. Đây là biên của nhóm lời nói trong đoạn, chưa phải căn từng câu/từ.
- Trình phát dùng timestamp khung hình khi phù hợp với vị trí video hiện tại; bỏ callback cũ sau tua. Trạng thái buffering ngăn vòng đồng bộ tự bật tiếng lại trước sự kiện `playing`.
- Tải sẵn audio hiện tại và hai đoạn kế tiếp; giải phóng các phần tử audio ngoài cửa sổ. Giữ URL audio đã chuẩn bị để tua lại không gọi GPU.
- Lệnh phát audio hoàn tất muộn sau pause/tua/dừng không được phép bật lại câu cũ.
- Trình phát thư viện giữ tốc độ video; căn tốc độ giọng vào khoảng lời nói. Mốc lời nói được lưu cùng đoạn qua migration `20260923010000_speech_timing`.

### Triển khai và xác nhận

1. Chạy `npm run check`, `python3 -m unittest discover -s tests -p 'test_*.py'`.
2. Triển khai `realtime_speech.py` lên Modal để có biên lời nói và số đo model. Backend cũ chưa trả timestamp vẫn được hỗ trợ, nhưng căn theo toàn đoạn.
3. Chạy migration mới trước khi chạy bản web mới; triển khai API chunk, API lưu và trình phát thư viện cùng nhau.
4. Reload extension 0.3.4 và tải lại YouTube. Thử 30 giây có khoảng im lặng, pause/resume, tua tiến/lùi trong vùng đã chuẩn bị, đổi tốc độ 0.75×/1.25×. Kiểm tra không thêm DOM/trình phát mới.
5. Thử đứng mạng khi phát, tua liên tục và Dừng khi đang tạo giọng. Không được nghe tiếp câu cũ. Thử lưu lỗi: giọng vẫn được giữ, popup phải báo lưu thất bại.
6. Đo thời gian chuẩn bị và độ lệch thực tế trên video dài; unit test không chứng minh đạt dưới 100 ms trên Chrome hay xử lý nhanh hơn realtime.

### Phần vẫn cần nguồn đọc trước

Với nguồn chỉ có `captureStream` của YouTube, bản này tiếp tục dùng lượt chuẩn bị rồi phát lại, không hứa xem lần đầu với giọng dịch tức thì. Tua ngoài vùng chuẩn bị vẫn dừng và báo thiếu bản dịch; chưa tự thu vùng mới vì việc thu sẽ phải chạy video tại vùng đó. Muốn vừa xem vừa dịch đi trước cần file/URL âm thanh hoặc phụ đề timestamp độc lập. Chưa có nguồn này thì không bật cơ chế read-ahead giả dựa trên đồng hồ.

ASR → dịch → TTS trong một request vẫn tuần tự và có khóa phiên. Việc đổi sang pipeline nhiều worker cần quản lý hạn mức/lease từng công đoạn, đo tải và kiểm tra model thread safety; không nới khóa tùy tiện trên model giọng dùng chung. Chưa thay model TTS, bật FP16 mới hoặc tăng GPU thường trực khi chưa có benchmark chất lượng/chi phí.


### Đo dịch vụ ASR/dịch ngày 23/09/2026

Mẫu giọng thử tiếng Việt dài 2,0907 giây, đích tiếng Anh, gọi từ máy phát triển tới Modal: yêu cầu đầu 49.842 ms; lượt nóng 3.437 ms. Lượt nóng báo ASR 104 ms và dịch 126 ms, chờ khóa 0 ms. Thời gian ngoài model gồm truyền mạng, nền tảng và xử lý request, chưa tách riêng. Đây không phải đo pipeline TTS hoặc độ lệch hình/tiếng và không dùng để suy ra tốc độ EN→VI trên mọi video. Sau phép đo, bước tải model đã thêm warmup CUDA/decoder trước khi `/health` báo sẵn sàng để chi phí khởi tạo được đưa vào giai đoạn chuẩn bị.

Bản ASR có warmup được xác nhận trả HTTP 200 ở hai lượt tiếp theo: 4.150 ms và 3.537 ms; model lần lượt 229 ms và 213 ms. Không xem đây là benchmark cold start đối chứng vì container có thể đã được khởi tạo trước lúc gửi yêu cầu.

## Đánh giá lại ngày 24/09/2026

Bản hiện tại chưa đáp ứng chế độ vừa xem YouTube vừa tạo thuyết minh đi trước liên tục. Xem [nghiên cứu kiến trúc và tiêu chí kiểm chứng](youtube-realtime-research.md). Đã sửa local lỗi `Extension context invalidated` trong `native-session.js`; sửa vòng đời này không thay thế việc chuyển nguồn sang transcript/audio có thể đọc trước.


## Sửa lỗi có đoạn đã xử lý nhưng không nghe thuyết minh — 0.3.3

Các lỗi xác nhận từ mã: `processed` tăng cả khi đoạn không có text/audio; đoạn im lặng xóa văn bản vừa nhận trước đó; kết thúc vùng đã chuẩn bị bị báo là vị trí chưa dịch. Ảnh chưa chứng minh nguyên nhân vật lý khiến audio đầu vào im lặng, nên bản này bổ sung mức RMS/peak và đếm riêng silent/noSpeech để phân biệt thu âm với lỗi ASR.

- Đổi nguồn PCM sang Chrome `tabCapture` trong offscreen. Không dùng audio track qua WebRTC của media element nữa. Luồng thu đóng trước khi phát thuyết minh, tránh thu lại giọng dịch trong tab.
- Khi thu, source được unmute và đặt volume 1; âm lượng nghe do gain offscreen điều khiển. Khi hoàn tất/dừng/lỗi, volume và mute ban đầu được khôi phục. Theo [Chrome tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture#preserve-system-audio), cần nối luồng vào AudioContext destination để giữ tiếng nghe trong lúc capture.
- Khi không bật lưu, không tạo WebRTC video hoặc MediaRecorder. Khi bật lưu, WebRTC chỉ chuyển hình; âm thanh bản ghi lấy từ tab capture. Chờ peer kết nối trước khi ghi.
- Không loại tiếng nhỏ bằng ngưỡng năng lượng phía client; chỉ bỏ qua mẫu gần như bằng 0, còn lại để VAD server quyết định.
- Không báo sẵn sàng nếu chưa có đoạn nào có cả audio và bản dịch. Lỗi này dừng phiên và trả lại trạng thái tiếng gốc. Giữ bản dịch gần nhất qua đoạn im lặng.
- Hết vùng đã chuẩn bị hiển thị hoàn tất, không báo lỗi chưa dịch. Tua thật sự ra ngoài vẫn báo thiếu dữ liệu.

### Kiểm thử bản sửa

1. Dừng phiên cũ; Reload TexTone trong chrome://extensions và **tải lại tab YouTube**. Popup phải ghi 0.3.4.
2. Phát thử để chắc chắn nghe tiếng YouTube, chờ hết quảng cáo; chọn đoạn diễn giả đang nói.
3. Tạo mã mới đúng ngôn ngữ (video tiếng Anh: nguồn Anh, đích Việt, chế độ Thuyết minh). Chọn 30 giây; **tắt Lưu hình** cho lần kiểm tra âm thanh đầu tiên.
4. Bấm Chuẩn bị bản dịch. Trong lúc thu phải nghe tiếng gốc; popup có Lời nói gốc/Bản dịch khi server hoàn tất, Đoạn đã dịch chỉ tăng khi có giọng WAV.
5. Khi xong, video quay về điểm bắt đầu; Đã phát phải tăng khi audio.play thành công. Thử pause, resume, tua trong vùng đó. Hết 30 giây hiển thị hoàn tất.
6. Nếu chưa nghe: mở Chi tiết xử lý. Mức thu −∞ dBFS với số im lặng tăng chỉ ra nguồn không có tín hiệu; có mức thu nhưng chưa nhận dạng tăng chỉ ra cần kiểm tra lời nói/ngôn ngữ/ASR. Có bản dịch nhưng lỗi giọng đọc thuộc TTS. Có giọng nhưng trình duyệt chặn phát sẽ có thông báo bấm Phát.
7. Sau khi nghe được, bật Lưu hình và kiểm tra lại. Không cần migration hoặc triển khai web mới để kiểm tra bản sửa capture này; metadata timestamp mới vẫn phụ thuộc backend tương ứng.

Kiểm thử tự động không thay thế nghe và xem trên Chrome thật; chưa khẳng định đã sửa mọi nguyên nhân gây im lặng trên máy người dùng.


## Sửa dừng ngay đầu vùng dịch — 0.3.4

Ảnh kiểm thử cho thấy 3 đoạn có giọng, input −21 dBFS, ASR và TTS đều hoàn tất nhưng Đã phát vẫn 0. Đã tái hiện hai lỗi trong controller bằng regression test trước khi sửa: chọn vùng bằng timestamp khung hình đứng trước điểm seek (ví dụ currentTime=13.812, mediaTime=13.800), và sai số số thực ngay đầu cue. Cả hai khiến mã cũ gọi onMissing dù video đã ở đúng đầu vùng chuẩn bị. Chưa có trace trực tiếp chứng minh ảnh của người dùng chỉ do hai nguyên nhân này.

Bản 0.3.4 chọn vùng theo video.currentTime; timestamp frame chỉ dùng để căn tiếng khi nằm trong cùng vùng đã chọn. Dung sai đầu cue tối đa 1 ms chỉ xử lý làm tròn; khoảng chưa dịch thực sự vẫn dừng. Bộ đồng bộ tạm khóa trong bước tua và tải giọng đầu; chờ seeked trước khi cho phép phát. Thông báo thiếu dữ liệu giờ ghi cả vị trí hiện tại và từng khoảng đã chuẩn bị để chẩn đoán nếu còn lỗi.

Reload 0.3.4 rồi tải lại tab YouTube; thử lại cùng video, cùng vị trí, 30 giây và tắt Lưu hình. Khi chuẩn bị xong phải thấy bước Đang đưa video về điểm bắt đầu rồi phát giọng; Đã phát phải tăng. Nếu vẫn báo thiếu dữ liệu, thông báo mới cần có các mốc giây cụ thể. Không cần deploy backend cho bản sửa này.

## Dịch trực tiếp — 0.4.0

Theo lựa chọn video chạy liên tục, popup mặc định chọn **Dịch trực tiếp**.
Phiên `dub` có thể chạy nhánh offscreen thu tab liên tục, không điều khiển
pause/seek của YouTube. Chuẩn bị trước vẫn là lựa chọn riêng để khớp hình/tiếng.

- Capture: tabCapture → offscreen AudioContext → worklet chia theo khoảng lặng
  (tối thiểu 1 giây, khoảng lặng 350 ms, tối đa 3 giây).
- Giọng dịch phát từ offscreen, không phát trong tab đang thu, tránh thu lại TTS.
- Theo dõi pause/seek/waiting/ratechange: dừng tiếng dịch, xóa PCM dở dang và hàng
  đợi; kết quả đang xử lý thuộc thế hệ cũ không được phát. Chuyển URL thì dừng phiên.
- Tối đa một request và một đoạn chờ mới nhất. Quá tải có thể bỏ đoạn; kết quả âm
  thanh quá 10 giây từ lúc kết thúc thu không phát. Bản mới thay tiếng cũ đang phát,
  vì vậy có thể cắt câu khi TTS chậm. Đây là đánh đổi độ trễ, không bảo đảm đủ mọi câu.
- Lưu video chỉ hỗ trợ chế độ chuẩn bị trước. Chế độ trực tiếp chưa cache theo
  timeline; tua đến vị trí khác sẽ nhận dạng lại âm thanh từ vị trí mới.

### Trạng thái streaming và nghiên cứu

Bản này thu liên tục nhưng **vẫn gọi `/api/realtime/chunk`**, không phải streaming
STT WebSocket. Không cần khóa Deepgram, không triển khai thêm dịch vụ trả phí.
HTTP không tự gây ra vài giây trễ: cửa sổ audio, endpointing, hàng đợi, cold start,
dịch và tổng hợp giọng đều phải được đo. Thay transport riêng lẻ không bỏ các khâu đó.

Deepgram hỗ trợ interim/final và endpointing. Không phát TTS từ interim vì văn bản
còn thay đổi. Các con số STT 250–400 ms không đại diện độ trễ từ đầu câu đến tiếng
thuyết minh. Bước WebSocket tiếp theo cần backend dài hạn, xác thực phiên/quota,
khóa provider nằm server, PCM frame ngắn, final transcript có timestamp và generation,
reconnect không phát lặp. Cần cấu hình provider và benchmark trước khi chọn Nova.

Nguồn chính thức:
- https://developers.deepgram.com/docs/using-interim-results
- https://developers.deepgram.com/docs/utterance-end
- https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture

### Kiểm thử thủ công

Reload extension và tab YouTube; xác nhận 0.4.0. Tạo mã phiên thuyết minh,
chọn Dịch trực tiếp, phát video và Bắt đầu. Video phải tiếp tục chạy, âm thanh
thuyết minh đến sau và số Đã phát tăng. Đóng popup vẫn chạy. Dừng video phải ngắt
giọng dịch; tua rồi phát không được phát lại kết quả trước lần tua. Kiểm tra
đổi video, dừng phiên, hết hạn và mạng chậm; ghi lại latency và số đoạn bỏ qua.
Chưa xác nhận các hành vi này trên Chrome thực tế chỉ bằng unit test.

## Pipeline QThread và nguồn YouTube — 0.5.0

Đã thêm mã nguồn cho hai lựa chọn riêng trong popup:

- **Thu tab trực tiếp — QThread pipeline**: gửi PCM qua WebSocket tới gateway;
  AudioWorklet vẫn chốt đoạn 1–3 giây, không phải STT tăng dần theo từng frame.
  Worker STT/dịch xử lý đoạn tiếp theo khi worker TTS đang tạo giọng đoạn trước.
  Tiếng dịch phát ở offscreen để không thu ngược vào nguồn. Khi quá tải, bỏ phần
  chờ cũ và báo bộ đếm; không cam kết đọc đủ mọi câu hoặc ngay khi câu vừa kết thúc.
- **YouTube đọc trước — thử nghiệm đồng bộ**: server resolve audio công khai bằng
  yt-dlp, FFmpeg giải mã trước playhead; không dùng cookie người xem. Thu nguồn,
  STT/dịch, TTS chạy trên QThread riêng với queue có giới hạn. Giữ trước khoảng
  24 giây; chuẩn bị vùng liên tục 6 giây trước khi phát (cuối video có thể ngắn hơn).
  Video gốc điều khiển tiếng dịch; không thêm DOM/player. Thiếu buffer thì pause.
  Seek tạo generation mới và tải lại ở vị trí đó. Chưa cache bền vững hoặc lưu video.

### Thành phần mới

- `realtime_pipeline.py`: gateway WebSocket trên CPU Modal, GPU endpoints hiện tại
  vẫn phục vụ model; không tăng concurrency trong cùng Viterbox instance mutable.
- `pipeline_core.py`: worker QThread, queue 2 đầu vào và 2 transcript, đóng hợp tác,
  lọc generation. Qt chỉ điều phối I/O; không khiến một lần inference tự nhanh hơn.
- `youtube_source.py`: chỉ nhận video ID chuẩn, canonical URL youtube.com, media
  host googlevideo.com; timeout extraction 35s, FFmpeg network timeout 15s, không
  cookie hoặc proxy vượt chặn. Nếu nguồn bị chặn phải hiển thị lỗi, không âm thầm chuyển chế độ.
- `/api/realtime/pipeline`: GET trả endpoint WSS cho phiên hợp lệ. POST chỉ cho
  worker có API key; lease riêng vẫn dùng bảng hiện có, không migration. Giữ lease
  120 giây, heartbeat 25 giây, quota cấp từng nhóm 5 đoạn (phần đã cấp chưa dùng
  có thể mất khi dừng). Phiên bị thay thế được phát hiện khi heartbeat/renew.
- Extension không nhận khóa model hoặc đường dẫn giọng riêng; token phiên truyền
  trong handshake WSS. Generation loại kết quả cũ sau pause/seek.

### Triển khai

1. `npm run check`.
2. `modal run realtime_pipeline.py`: kiểm thử QThread và WebSocket trên Linux;
   kiểm tra truy cập YouTube từ Modal. Qt wheel trên máy kiểm thử macOS hiện tại
   báo thiếu NEON, vì vậy không coi kiểm thử local bị lỗi đó là model GPU lỗi.
3. `modal deploy realtime_pipeline.py`: tạo gateway mới dùng secret Modal hiện có
   `chatterbox-api-key`. Không tăng GPU always-on hoặc thay model.
4. Triển khai riêng route pipeline trên web; cấu hình
   `REALTIME_PIPELINE_URL=wss://dtug20--textone-pipeline-serve.modal.run/stream`.
   Không cần thay schema. Source production phải được giữ nguyên ngoài route này.
5. Reload extension và YouTube, chọn một trong hai chế độ mới. Chế độ cũ vẫn có
   sẵn; mặc định chưa chuyển sang pipeline nếu server chưa triển khai.

### Đo và giới hạn

Trên máy hiện tại, video `Hu4Yvq-g7_Y` lấy/giải mã 6 giây nguồn trong khoảng
2.2 giây; RMS 0.0316. Đây không gồm STT/TTS. Trên Modal, một lượt không lấy được
nguồn, lượt tiếp theo resolve được URL trong 1.82 giây. Resolve URL chưa chứng
minh tải được PCM. Không khẳng định mọi video hoặc mọi IP server truy cập được.

Độ khớp hiện theo biên nhóm lời nói trong đoạn 3 giây, chưa phải căn từng câu/từ
hay khẩu hình. TTS vẫn trả WAV hoàn chỉnh. Mục tiêu “câu vừa kết thúc là có giọng”
chưa được đo/đảm bảo; cần đo GPU thật và Chrome thật sau khi backend được bật.

Triển khai web đang chờ xác nhận: automatic approval review từ chối đọc mã
production bằng tài khoản Vercel và sao chép `.env.local` vào release directory.
Không thực hiện thao tác đó hoặc đi vòng qua chặn. Route và các kiểm thử đã chuẩn
bị ở workspace; chưa đưa route lên textone.id.vn ở thời điểm ghi mục này.

Kết quả kiểm tra bổ sung: 96 kiểm thử JS/TS, lint/typecheck đạt; 4 kiểm thử Qt và
WebSocket trên Modal đạt, gồm chạy chồng STT/TTS và shutdown hợp tác khi đóng
socket. Lượt kiểm tra nguồn sau cùng trả `YOUTUBE_AUTH_REQUIRED`; vì vậy chưa
xác nhận tải/giải mã được audio trên server và chưa công bố read-ahead hoạt động
ổn định. Không đưa cookie người dùng lên để vượt lỗi này.

Gateway đã triển khai thành công tại
`https://dtug20--textone-pipeline-serve.modal.run`; `/health` trả
`{"ready":true,"protocol":2,"workers":"QThread","contextAware":true}`.
Đây mới là gateway: extension 0.5.0 cần API pipeline trên web và biến môi trường
ở bước 4 trước khi dùng hai chế độ mới. Web production chưa được cập nhật do
chặn phê duyệt kể trên. Chưa có kiểm tra Chrome end-to-end hoặc benchmark GPU
thật qua giao thức mới. Các chế độ 0.4.0 vẫn giữ để dùng trong lúc chờ.

## Phát nối tiếp và chuyển sang GPU LAN — 03/10/2026

Nhánh thu tab QThread đã thay việc dừng tiếng đang đọc khi WAV mới về bằng
lập lịch AudioContext nối tiếp. Giải mã giữ thứ tự; đệm khởi phát 120 ms,
giới hạn phần chờ 6 giây và tuổi đoạn 12 giây. Pause/seek/stop hủy mọi source
đã lên lịch. Nếu inference chậm hơn tốc độ lời nói vẫn có thể thiếu tiếng hoặc
bỏ đoạn; thay đổi này không bảo đảm zero latency hay đồng bộ môi. Bộ đếm Đã phát
hiện bao gồm đoạn đã lên lịch, chưa phải xác nhận người nghe đã nghe hết.

Máy đích được yêu cầu: `atin-tts@192.168.1.198`, thư mục
`/home/atin-tts/dang/tung`. SSH hiện trả `Permission denied (publickey,password)`;
chưa cài đặt hoặc thay đổi dịch vụ nào trên máy này. Cần SSH key hợp lệ trước
khi kiểm tra GPU/VRAM/CUDA, dịch vụ đang chạy và chọn model. Không gửi private key
hay mật khẩu trong hội thoại.

IP này là LAN: backend Vercel/Modal không tự truy cập được. Khi triển khai cần
chọn gateway cùng máy và WSS với chứng chỉ hợp lệ/hostname truy cập được, hoặc
kết nối mạng riêng đã cấu hình. Không đổi endpoint production thành IP LAN trước
khi kiểm chứng kết nối. Di chuyển STT/dịch riêng vẫn để lại độ trễ TTS ở Modal;
benchmark phải bao gồm cả TTS, mạng và thời gian từ kết thúc thu đến phát tiếng.

### GPU LAN — 0.5.1

Đã bổ sung trường Pipeline riêng trong popup; dùng `ws://localhost:18802/stream`
qua SSH tunnel hoặc WSS. Không cho phép WS không mã hóa tới IP LAN/public.
Web vẫn xác thực phiên bằng API hiện tại. Build Docker tái sử dụng logic model và
gateway từ source Modal; không phụ thuộc Modal runtime trên máy LAN.
Hướng dẫn vận hành: [deploy/lan/README.md](../deploy/lan/README.md).

Máy được kiểm tra có RTX 3090 24 GB, khoảng 12 GB VRAM trống và GPU đang chia sẻ
cho các dịch vụ khác. Triển khai riêng dưới `textone-lan`, không dừng container khác.
Thư viện giọng TTS vẫn dùng dịch vụ cũ. Chưa suy ra độ trễ end-to-end từ GPU mới.

## Theo kịp tốc độ lời nói — 0.5.2

Gateway Docker LAN nay chờ health của STT và tạo thử một câu ngắn bằng đúng
giọng TTS trước khi phát `ready`. WAV warmup không gửi về trình duyệt.
Chỉ health TTS chưa đủ: đo thực tế vẫn mất 44 giây ở lần tạo giọng đầu.
Trước đây `/health` và `/generate` có thể chạy đồng thời vào dịch vụ GPU chỉ nhận
một request/container, gây nguy cơ tạo thêm container lạnh và tích audio cũ.
Thời gian khởi động được đưa vào bước chuẩn bị; không cam kết loại bỏ cold start.

Giọng live được FFmpeg `atempo` căn theo khoảng speechStart–speechEnd của nguồn,
không làm chậm giọng ngắn, tăng tối đa 1.35× và giữ cao độ. WAV trả về là PCM16 có
header độ dài hợp lệ. Không thay đổi tốc độ YouTube. Chế độ read-ahead giữ bộ căn
thời gian riêng, không áp dụng hai lần. Popup hiển thị hệ số tốc độ giọng trong
Chi tiết xử lý. Hai kiểm thử audio kiểm tra thời lượng và tần số sóng sau xử lý;
tổng 6 kiểm thử pipeline/audio chạy thành công trong Docker trên server.

Đây là giảm trễ tích lũy do giọng đọc dài, không phải streaming TTS: vẫn phải đợi
WAV hoàn chỉnh. TTS vẫn ở dịch vụ từ xa; nếu tốc độ tạo WAV chậm hơn tốc độ đầu vào
thì vẫn có thể thiếu/bỏ đoạn. Không tuyên bố tiếng dịch đến đồng thời với transcript.
Reload extension 0.5.2, tải lại YouTube, dùng mã phiên mới và pipeline LAN như trước.

Kiểm thử cuối trên Docker ngày 03/10: warmup bằng câu thật mất 6.990 ms trong
lượt đo này (không phải đối chứng cold start). Gửi liên tục mẫu 3 giây, mỗi 3 giây
một đoạn: các kết quả đầu 3.356 / 3.317 / 3.164 / 3.221 / 3.142 ms kể từ gửi xong
đoạn. Đây là mẫu lặp ngắn, chưa đại diện video dài hay nhiều người dùng. Phần
STT/dịch khoảng 0,3 giây, TTS khoảng 2,6–2,8 giây. Không suy ra giọng đã đến cùng
lúc transcript, và chưa xác nhận độ khớp thực tế trên Chrome của người dùng.

Lượt thứ sáu của phép đo trên lên 6.151 ms, với 5.990 ms bên trong gateway nhưng
STT 372 ms và TTS 2.593 ms: phần chờ bổ sung xuất hiện ở bước xin quota sau nhóm
5 đoạn. Đã chuyển sang prefetch quota khi còn 2 đoạn trên worker I/O riêng, vẫn
khóa cập nhật lease và quota, vẫn chặn nếu quota thật sự cạn. Khi stop phải đợi
refill hoàn tất trước release để không gia hạn lại lease đã giải phóng.

Sau prefetch quota, chạy lại cùng cadence 3 giây/đoạn: 3.246 / 2.832 / 3.008 /
3.338 / 2.896 / 3.131 ms; đủ 6 WAV, 0 dropped. Lượt warmup này mất 7.030 ms;
không phải đo cold start kiểm soát. Đoạn thứ sáu không còn bước nhảy 6,15 giây
trong lượt thử này. Reproduce: `node scripts/benchmark-lan-cadence.mjs sample.wav`
sau khi tạo phiên diagnostic. Tốc độ theo kịp cadence mẫu không đồng nghĩa tiếng
đã phát đồng thời với transcript hoặc bảo đảm mọi video sẽ không tích hàng đợi.

## Một luồng thuyết minh trực tiếp — 0.6.1

Extension chỉ còn một nghiệp vụ trong popup: thu âm thanh của tab hiện tại, gửi
WebSocket tới pipeline, rồi phát giọng dịch trong offscreen document. Đã bỏ toàn bộ
lựa chọn chuẩn bị, read-ahead và QThread khỏi giao diện. Trình phát YouTube không bị
chèn hoặc thay đổi DOM; mức âm thanh gốc chỉ đi qua gain của luồng tab đã capture.
Pause, seek, đổi video và stop tăng generation, xóa PCM đang chờ và dừng mọi nguồn
Web Audio đã lên lịch. Extension tự phát hiện gateway qua SSH tunnel ở
`localhost:18802`, nếu không có thì dùng WSS do `/api/realtime/pipeline` trả về.

AudioWorklet chốt câu sau 250 ms im lặng khi đã có ít nhất 750 ms lời nói. Khi
người nói liên tục quá hai giây, bộ thu giữ lại 320 ms âm thanh ở hai phía ranh
giới thay vì cắt mất nửa từ. Gateway dùng văn bản đã nhận làm `initial_prompt`,
khử các từ lặp do phần âm thanh chồng lấn và gom các cửa sổ bị cắt cưỡng bức thành
cụm tối đa khoảng 3,5 giây trước khi dịch và tạo giọng. Khoảng nghỉ tự nhiên vẫn
được xử lý ngay. Cách này tăng ngữ cảnh dịch cho lời nói nhanh mà không tạo hàng
đợi tăng dần; đổi vị trí hoặc pause sẽ xóa cả âm thanh lẫn ngữ cảnh đang giữ.

WAV trả về được xếp nối tiếp với 30 ms lead; backlog trên sáu giây hoặc kết quả
trên 12 giây bị bỏ để không đọc sai vị trí sau video. Popup hiển thị `totalMs` của
backend là độ trễ xử lý sau khi upload, tách khỏi thời gian cần nghe đủ cụm nguồn.

TTS tiếng Việt trên Docker LAN đã chuyển từ Viterbox từ xa sang Piper 1.8.0 và
`vi_VN-vais1000-medium` chạy resident trong container riêng. Voice dùng dataset
CC BY 4.0; Piper là GPL-3.0-or-later. Gateway yêu cầu `length_scale=0.76`, sau đó
chỉ dùng `atempo` giữ cao độ khi WAV còn dài hơn khoảng lời nói, tối đa 1.5×.
Container cần quota 16 vCPU trên máy đang chia sẻ; ở quota 2 vCPU cùng một câu mất
14–19 giây, trong khi 16 vCPU còn khoảng 0.47–0.59 giây khi gọi trực tiếp.

Benchmark pipeline EN→VI sau warmup: STT+dịch 0.475–0.650 giây, TTS 0.371–0.517
giây, tổng trong gateway 0.924–1.042 giây; client nhận kết quả sau 1.095–1.321 giây.
Cadence sáu đoạn, ba giây một đoạn: đủ sáu WAV, 0 dropped, tổng gateway
0.905–1.012 giây. Startup warmup 7.5–9 giây xảy ra trước trạng thái `ready`.
Đây là phép đo một mẫu trên máy chủ đang chia sẻ, không phải cam kết không độ trễ:
nguồn live vẫn phải kết thúc khoảng im lặng hoặc đủ hai giây trước khi model xử lý.

Kiểm thử giao thức v2 cắt một câu 3,68 giây tại mốc 2 giây và chồng lấn 320 ms.
Mảnh đầu chỉ tạo transcript tạm; mảnh sau tạo đúng một câu hoàn chỉnh và một WAV.
Từ cụt `s-` ở mép đầu được thay bằng `stay`, kết quả nguồn là
`Real-time speech translation should stay synchronized with the video.` Thời gian
backend sau khi nhận mảnh cuối là 0,919 giây: STT+dịch 0,560 giây, TTS 0,359 giây.
Lượt cadence riêng gồm sáu đoạn trả đủ 6/6 WAV, không dropped, tổng backend
1,045–1,214 giây.

## Đọc trước YouTube và đồng bộ timestamp — 0.7.1

Luồng mặc định cho URL YouTube hợp lệ không còn dịch đuổi theo âm thanh tab. Khi
bấm Bắt đầu, extension tạm dừng video gốc, gateway lấy audio công khai từ đúng
video và xử lý trước tối đa 24 giây so với playhead. Khi có ít nhất sáu giây clip
liên tục, video gốc và giọng dịch chạy theo cùng `currentTime`. Extension không
chèn DOM hoặc thay controls; nó chỉ điều khiển play/pause, mức tiếng gốc và một
phần tử Audio riêng. Pause dừng giọng. Seek tăng generation, hủy decoder/kết quả
cũ, xóa hàng đợi và chuẩn bị lại từ timestamp mới.

Nguồn được chia theo khoảng lặng kéo dài 350 ms sau tối thiểu 4,5 giây. Nếu người
nói liên tục, cửa sổ tối đa 10 giây giữ nhiều ngữ cảnh hơn ranh giới đều 2–6 giây.
Khoảng im lặng dài được tách khỏi đầu câu kế tiếp. Whisper trả `speechStart` và
`speechEnd`; player chỉ phát TTS trong chính khoảng lời nói đó và co giãn giọng
theo độ dài câu mà không đổi tốc độ video. Whisper large-v3-turbo, NLLB-1.3B và
Piper được giữ resident trên Docker GPU/CPU LAN.

Phép thử video `-moW9jvvMr4` trên bản gateway trước thay đổi ngắt câu đã xác nhận
server lấy được nguồn dài 565 giây và trả các clip timestamp liên tục. Hai đoạn
đầu 0–12 giây im lặng; đoạn 12–18 giây bị cắt giữa câu, là dữ liệu tái hiện dẫn
đến bộ chia theo khoảng lặng/cửa sổ 10 giây ở bản này. Cần chạy lại benchmark sau
khi Docker host trực tuyến để xác nhận câu hoàn chỉnh và thời gian xử lý bản mới.

Giới hạn: video phải công khai, không live, không DRM và không yêu cầu cookie đăng
nhập. NLLB-1.3B dùng giấy phép CC-BY-NC-4.0 và model card không phát hành cho mục
đích production; phải thay model có giấy phép phù hợp trước khi thương mại hóa.

## Phụ đề YouTube trong tab — 0.8.0

Lỗi `YOUTUBE_AUTH_REQUIRED` xuất hiện vì luồng 0.7.1 yêu cầu `yt-dlp` trên máy GPU
lấy GoogleVideo audio bằng IP máy chủ. YouTube có thể yêu cầu cookie, OAuth hoặc
PO token cho request này dù chính video vẫn phát bình thường trong Chrome. Luồng
0.8.0 không còn phụ thuộc request audio đó: service worker chạy một hàm giới hạn
trong MAIN world của tab, đọc caption track từ player response và fetch JSON3 bằng
chính phiên YouTube của người dùng. URL caption/cookie không rời khỏi trang; chỉ
tối đa 2.000 cue đã chuẩn hóa, mỗi cue tối đa 1.000 ký tự, được gửi qua extension.

Extension ưu tiên track đúng ngôn ngữ đích. Nếu chỉ có phụ đề nguồn, nó yêu cầu
bản dịch tự động bằng `tlang`, sau đó gom các fragment lặp thành câu 2–10 giây và
giữ timestamp. Gateway kiểm tra lại biên thời gian, tạo các đoạn im lặng phủ kín
timeline và gửi thẳng câu dịch tới QThread TTS; STT và NLLB đều không chạy. Pause,
seek và đổi video vẫn tăng generation nên audio cũ không thể phát sau vị trí mới.
Nếu không lấy được phụ đề hoặc khởi động luồng caption thất bại, player được khôi
phục rồi extension tự chuyển sang thu âm tab thay vì báo `YOUTUBE_AUTH_REQUIRED`.

Benchmark Docker production ngày 16/10/2026: hai cue thử tạo WAV trong 462 ms và
396 ms; `sttMs=0`, `asrMs=0`, `translationMs=0`. Event `ready` đầu tiên mất khoảng
2,43 giây do warmup TTS. Đây là số đo một phiên trên server LAN, không phải SLA.
Độ khớp phụ thuộc timestamp và chất lượng phụ đề YouTube; fallback audio vẫn phải
nghe đủ một cụm lời nói rồi mới chạy STT/dịch nên có độ trễ cao hơn.

## Ghép câu và nhịp giọng — 0.8.1

Lỗi giọng chậm xuất phát từ player lấy `audio.duration / caption.duration` cho cả
hai hướng. Khi WAV chỉ dài 2 giây nhưng cue dài 4 giây, playback rate bị hạ xuống
0,5×. Bản 0.8.1 giữ tối thiểu 1×: WAV ngắn phát ở tốc độ tự nhiên rồi để phần còn
lại im lặng; WAV dài được FFmpeg `atempo` co tối đa 1,8× trên gateway rồi player
căn phần chênh lệch còn lại theo đồng hồ video. Player preload sáu câu và chỉ bắt
đầu sau khi có timeline liên tục 10 giây để tránh dịch đuổi ở lời nói nhanh.

Collector chỉ nhận track đúng ngôn ngữ nguồn, ưu tiên phụ đề chuẩn rồi mới dùng ASR
tự động. Các fragment ngắn được ghép theo khoảng nghỉ, dấu kết câu, số từ và giới
hạn 11,5 giây. Nếu YouTube có track đích thì dùng trực tiếp; nếu chỉ có phụ đề tiếng
Anh, gateway gửi nguyên câu tới endpoint `/translate` và bỏ qua Whisper. Translator
production đã chuyển sang `VietAI/envit5-translation`; bản dịch tự động YouTube chỉ
là fallback khi có nội dung đích hợp lệ.

Benchmark Docker production ngày 16/10/2026 với hai câu hoàn chỉnh: ASR 0 ms; dịch
EnViT5 689/572 ms; Piper TTS 670/498 ms. WAV dài 3,785/2,577 giây trong hai cue
4 giây, nên phát ở 1× và không còn bị kéo chậm. Tổng pipeline 1,368/1,866 giây,
nằm trong buffer khởi động 10 giây. Đây là phép thử pipeline; kiểm tra cảm nhận và
timestamp trên video YouTube thật vẫn cần thực hiện sau khi reload extension.

## Ưu tiên phụ đề và tăng nhịp đọc — 0.8.2

Extension chọn phụ đề tiếng Anh do tác giả cung cấp trước. Chỉ khi không có track
này, nó mới dùng track `kind=asr` do YouTube tự động tạo. Piper giảm
`length_scale` từ 0,82 xuống 0,76, tương đương tăng nhịp đọc khoảng 8% mà không đổi
cao độ. Các WAV dài vẫn được ép vừa cue và trình phát dừng âm thanh đúng ranh giới
timestamp, vì vậy một câu không được phép chèn sang câu kế tiếp.

## Dịch trước theo timeline — 0.8.3

Phụ đề YouTube cung cấp timestamp của phần nội dung phía trước nên pipeline không
cần đợi người nói kết thúc câu theo thời gian phát. Collector ghép tối đa 18 giây
thành một câu ngữ nghĩa, gửi toàn câu cho EnViT5, rồi tạo WAV trước khi playhead tới
timestamp đầu câu. Gateway duy trì cửa sổ chuẩn bị 60 giây; player đợi một lần cho
15 giây timeline liên tục và preload 12 WAV kế tiếp. Popup hiển thị số giây đã
chuẩn bị trước để phân biệt độ trễ xử lý với độ trễ chủ động lúc khởi động.

Khi tua, generation cũ bị hủy và video lại chờ đủ vùng đệm tại vị trí mới. Nếu
pipeline không theo kịp, video dừng tại ranh giới chưa có audio thay vì để bản dịch
trễ hoặc phát nhầm sang phụ đề kế tiếp.
