# Nghiên cứu lại kiến trúc thuyết minh YouTube — 24/09/2026

## Kết luận

Bản hiện tại là **thu trước, xử lý rồi phát lại**. Nó chưa đáp ứng yêu cầu xem YouTube và nghe bản dịch đồng bộ liên tục sau một khoảng đệm ngắn. Tối ưu upload, warmup hoặc đổi GPU không biến kiến trúc này thành luồng đọc trước.

Đề xuất: **ưu tiên transcript có timestamp; nguồn audio độc lập là phương án thứ hai; thu trực tiếp chỉ là fallback có giới hạn được công bố rõ**. Chưa xác nhận lấy được transcript của video trong ảnh; việc này phải được kiểm chứng trên trình duyệt trước khi triển khai pipeline mới.

## 1. Hai nguyên nhân khác nhau

### Lỗi trong ảnh

`native-session.js` gọi `chrome.runtime.sendMessage()` trong một hàm thường. Khi context extension mất hiệu lực, lời gọi có thể ném lỗi đồng bộ trước khi có Promise. Vì thế `.catch()` gắn phía sau không bắt được lỗi đó. `next()` lại gọi `report()` trong catch, có thể phát sinh lỗi lần hai.

Reload/cập nhật extension khi tab còn giữ script cũ là nguyên nhân phù hợp nhất với ảnh, chưa phải một sự kiện đã được quan sát trực tiếp. Chrome hướng dẫn khi sửa content script phải reload cả extension lẫn trang chứa nó: [Chrome — reload requirements](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#when-to-reload-the-extension).

Bản sửa local: đưa gửi message qua hàm async; khi context invalidated thì dừng timer, audio và peer/track cục bộ, khôi phục mute/tốc độ nguồn, bỏ state cũ; cleanup không phụ thuộc runtime còn sống. Kiểm thử cả lỗi đồng bộ và Promise rejection. Đây là xử lý vòng đời, không phải triển khai realtime mới. Script cũ đang nằm trong tab không tự nhận mã vừa sửa: vẫn cần reload tab một lần.

### Sai khác về nghiệp vụ

`BufferedSession.collect()` chỉ thu khi video gốc chạy; `native-session.js` chờ finished mới phát lại. API `/chunk` vẫn chờ toàn bộ TTS WAV qua `arrayBuffer()`. NDJSON đang stream tiến độ/transcript, không phải stream các mẫu audio ngay từ TTS. Khóa phiên giữ toàn bộ request nên không có pipeline ASR câu sau / TTS câu trước giữa các request của cùng phiên.

Theo [đặc tả captureStream](https://www.w3.org/TR/mediacapture-fromelement/), luồng thu là nội dung đang được media element render. Từ đó suy ra: dừng video gốc cũng làm mất tiến triển của nguồn thu; không thể tạo khoảng cách đọc trước bằng cách chỉ thêm timestamp hay bộ đệm vào chính nguồn đó. Muting phần tử không làm tiếng capture mất đi; không nên nhầm mute của phần tử với track không có dữ liệu.

## 2. Chọn nguồn trước khi chọn GPU

| Nguồn | Khả năng đọc trước | Quyết định |
|---|---|---|
| Transcript/phụ đề có timestamp của video | Có, nếu lấy được nội dung ngoài câu đang hiển thị | Ưu tiên cho video có phụ đề. Bỏ ASR, chỉ dịch và TTS. |
| File hoặc URL audio độc lập có quyền truy cập | Có | Backend đọc theo khoảng thời gian, ASR/dịch/TTS đi trước hình. |
| Chỉ captureStream của video đang xem | Không có audio tương lai | Giữ chế độ chuẩn bị hoặc báo chưa hỗ trợ đồng bộ liên tục. |
| Livestream chỉ có nội dung vừa phát sinh | Không có nội dung tương lai | Cần trì hoãn cả hình và tiếng so với nguồn; không hứa dịch tức thì trên cùng live edge. |

YouTube có chức năng xem transcript cho video có captions: [YouTube Help](https://support.google.com/youtube/answer/15930243?hl=en-GB). Tuy nhiên khả năng xem trên UI không phải cam kết API để extension tải toàn bộ transcript. Bộ lấy nguồn cần chứng minh lấy được các cue phía trước vị trí hiện tại, giữ videoId/ngôn ngữ/độ phủ, khử các cue tự động bị lặp và báo lỗi cụ thể khi thiếu nguồn.

API chính thức `captions.download` yêu cầu quyền chỉnh sửa video; không thể dùng nó như dịch vụ tải phụ đề mọi link: [YouTube Data API](https://developers.google.com/youtube/v3/docs/captions/download).

Có thể làm adapter thử nghiệm cho transcript mà phiên xem hiện tại truy cập được, nhưng endpoint nội bộ/DOM YouTube không ổn định. Không mở transcript panel hoặc bật/tắt CC sau lưng người dùng để giả vờ giữ nguyên UI. Nếu adapter không lấy được dữ liệu, hiển thị thiếu nguồn; không coi mảng rỗng là video không có lời nói. Thư viện [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api) hỗ trợ cue có thời gian nhưng chính dự án ghi nhận cloud IP bị chặn. Không chọn nó làm dependency đảm bảo hoạt động với mọi video từ Vercel/Modal.

[yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) ghi nhận yêu cầu PO token và lỗi 403 cho một số luồng. Nó có thể là adapter nguồn riêng khi phù hợp, nhưng không phải giải pháp cài một lần rồi bảo đảm mọi link. Không triển khai cơ chế vượt chặn, lấy cookie hoặc gửi phiên đăng nhập người dùng sang server trong nghiên cứu này.

Không ưu tiên nhân đôi video ẩn: sao chép `video.src` không bảo đảm tạo nguồn đọc độc lập; với MSE, URL có thể tham chiếu đối tượng MediaSource chứ không phải file. [MDN MSE](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API). IFrame API hỗ trợ điều khiển player nhưng không cung cấp API PCM audio; cần thêm cơ chế thu khác, điều kiện nhúng và quản lý hai timeline. [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference).

## 3. Pipeline đề xuất

```text
Source resolver → cue timeline → dịch theo cụm nghĩa → TTS → audio cache
                        ↑                               ↓
                   seek priority              contiguous ready coverage
                                                        ↓
YouTube gốc: currentTime / pause / seek / rate → bộ phát audio độc lập
```

Không thay DOM hoặc controls của trình phát; popup hiển thị trạng thái. Backend xử lý phía trước trong lúc YouTube phát nội dung đã sẵn sàng. Trước khi có cue/audio đầu tiên thì tạm dừng tại đúng điểm xem, không chạy video âm thầm qua 30 giây rồi tua lại.

Mỗi cue giữ `videoId`, `sourceStart`, `sourceEnd`, `text`, `translation`, `voiceId`, `modelRevision`, `audioDuration`, `revision`. Cache bền vững phải tách quyền tổ chức với giọng custom. Cache audio đã hoàn tất; không cache lỗi như kết quả hợp lệ.

- Chỉ phát khi có **vùng sẵn sàng liên tục**, tính cả những đoạn im lặng đã biết. Có câu ở giây 40 không đồng nghĩa sẵn sàng từ giây 0 đến 40.
- Điểm khởi đầu thử nghiệm: 8–12 giây vùng sẵn sàng, hướng tới giữ 20–40 giây phía trước. Đây là tham số thử nghiệm, không phải cam kết chờ 8 giây là xong.
- Ưu tiên 2–3 câu gần playhead, xử lý thêm khi bộ đệm thấp. Thông lượng phải nhanh hơn tốc độ tiêu thụ, kể cả khi người dùng chọn 1.5×/2×.
- Dịch theo nghĩa với ngữ cảnh lân cận, không đọc từng cue lặp của auto captions. Giữ ánh xạ cụm đã dịch về khoảng nguồn.
- Hoàn tất audio một câu trước khi căn chính xác thời lượng câu đó. Streaming TTS giúp nhận audio sớm nhưng không tự biết tổng độ dài cuối cùng.
- Giới hạn co giãn vừa phải, thử nghiệm khoảng 0.85–1.20× cho việc khớp câu, độc lập với tốc độ người dùng. Câu quá dài cần dịch ngắn lại hoặc tạo giọng lại; không tự tăng lên 4× để gọi là đã đồng bộ.

## 4. Pause và tua

Video gốc là đồng hồ chính. Audio chỉ theo media time, không theo thời gian request về. Pause, waiting, seeking phải dừng tiếng. Khi seek, tăng generation ID, hủy lịch phát cũ, ưu tiên vị trí mới; kết quả generation cũ không được tự phát. Kết quả đó chỉ được đưa vào cache nếu vẫn thuộc đúng video/giọng/model.

Tua đến audio đã cache: tìm cue và offset, phát cùng vị trí video mới. Tua đến vùng chưa có: dừng tại điểm mới, chuẩn bị vùng đó, rồi chỉ tự tiếp tục nếu người dùng trước đó có ý định phát. Nếu người dùng đã bấm pause trong lúc chờ thì không tự phát. Không được tiếp tục chép câu trước khi tua hoặc tua nguồn về vị trí cũ.

## 5. Model và đường truyền

Ưu tiên bỏ ASR khi transcript đủ tốt. Với nguồn audio, faster-whisper hiện có có thể tiếp tục làm baseline; đánh giá chính sách chốt văn bản tăng dần thay vì mỗi 4 giây nhận dạng rời rạc. [SimulStreaming](https://github.com/ufal/SimulStreaming) là tham khảo cho xử lý tăng dần, nhưng cần kiểm tra riêng cặp Anh–Việt và phần dịch đang dùng; không giả định mọi model trong stack mẫu hỗ trợ tiếng Việt tốt.

Ứng viên benchmark TTS tiếng Việt: [VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS), có API infer_stream và backend GPU/CPU. Tác giả công bố TTFA khoảng 115 ms trên RTX 3060 cho cấu hình mẫu; chưa phải số đo trên hạ tầng này, cũng không phải thời gian tạo xong cả câu. So sánh trực tiếp với Viterbox trên cùng bộ câu và giọng trước khi thay.

[Chatterbox-Turbo](https://github.com/resemble-ai/chatterbox) là ứng viên tiếng Anh; không suy ra hỗ trợ tiếng Việt chỉ vì tên cùng họ Chatterbox.

Giữ worker model nóng trong phiên hoạt động; cache điều kiện giọng; để dịch và TTS gần nhau về mạng. Tách API xác thực/quota khỏi worker inference. Nếu dùng truyền audio tăng dần, truyền binary PCM/Opus có metadata thay vì đợi WAV rồi base64 toàn bộ. Không thêm WebSocket chỉ để chuyển cùng một blob cuối request: thay transport không tự làm inference nhanh hơn.

Chạy pipeline có hàng đợi giới hạn giữa công đoạn. Nới concurrency bằng scheduler có hỗ trợ hoặc replica riêng, không gọi đồng thời trên instance Viterbox có trạng thái mutable. Giữ hạn mức theo phiên/công đoạn; không bỏ khóa phiên rồi cho phép tạo vô hạn tác vụ TTS.

## 6. Các bước cần chứng minh trước khi gọi là đáp ứng yêu cầu

1. **Nguồn:** trên tập video thực có/không có captions, xác nhận đọc được các cue tương lai mà không đổi giao diện. Lưu tỷ lệ thành công và phân loại unavailable/blocked/live, không chỉ test một video thuận lợi.
2. **Model:** đo ít nhất 100 câu Anh–Việt có tên riêng, số, câu dài/ngắn; TTFA, thời gian xong câu, p50/p95, RTF, độ dài audio, chất lượng phát âm. So sánh 1/4/8 phiên; warm và cold tách riêng. Pin model revision.
3. **Bộ phát:** kiểm thử Chrome thật 20–30 phút, pause/resume, 20 lần tua nhanh, tua ra vùng cache, mạng gián đoạn, tốc độ 0.75/1/1.5/2, đổi video trong SPA, quảng cáo, reload extension.
4. **Tiêu chí thử nghiệm:** drift timeline p95 ≤100 ms khi phát ổn định; không có câu cũ sau tua; không tăng trễ theo thời lượng. Thời gian chờ nguồn/TTS và độ khớp ngữ nghĩa cần đo riêng với drift kỹ thuật.
5. **Phát hành:** chỉ công bố nguồn và cấu hình đã qua kiểm thử. Chưa có nguồn đọc trước thì chưa công bố “realtime đồng bộ cho mọi video YouTube”.

## Trạng thái thực hiện

Đã nghiên cứu tài liệu gốc và sửa local lỗi gửi message khi context mất hiệu lực, có regression test. Chưa triển khai kiến trúc transcript-first, chưa benchmark model thay thế, chưa xác nhận end-to-end trên video trong ảnh. Không có triển khai production hoặc migration mới trong lượt nghiên cứu này.

## Bổ sung: phát đồng bộ sau đệm ban đầu và lựa chọn GPU

Yêu cầu mới nhất ưu tiên khớp hình/tiếng sau thời gian chuẩn bị ban đầu. Bản 0.4.0
chạy liên tục và phát giọng trễ là chế độ khác, không đáp ứng yêu cầu này.

### Phương án và điều kiện khả thi

1. Transcript tương lai truy cập được: dịch/TTS đi trước; không cần STT. Cần xác
   nhận nguồn phụ đề và độ chính xác, không coi auto-caption là ground truth.
2. Audio độc lập truy cập được: worker đọc trước, STT căn thời gian, dịch và tạo
   từng câu; đây là fallback phù hợp khi không có transcript.
3. Chỉ tabCapture: xử lý toàn phần đã thu rồi phát lại; hoặc trì hoãn cả hình lẫn
   tiếng trong một player riêng. Cách thứ hai thay đổi player, không đáp ứng yêu
   cầu giữ nguyên UI. Chỉ trì hoãn TTS thì vẫn lệch hình.
4. Player nguồn thứ hai chạy trước: có thể thử nhưng cần nguồn truy cập độc lập,
   đồng bộ quảng cáo/timeline và quyền capture. Không phải giải pháp phổ quát cho
   video riêng tư, chặn nhúng hoặc livestream. Không triển khai ngầm tab/player mới.
5. Livestream: không có tương lai để tải trước; cần phát chậm hơn nguồn và một
   nhánh ingest tiếp tục chạy độc lập với nhánh playback.

### Điều kiện chạy liên tục

Gọi q là số giây nội dung nguồn đã hoàn tất xử lý trong một giây thực tế; tốc độ
xem là v. Buffer thay đổi theo q-v. Muốn không cạn buffer cần q > v về dài hạn,
và dự phòng cho p95/p99, mất mạng, câu dài, quảng cáo, nhiều phiên đồng thời.
Ví dụ minh họa: hoàn tất 4 giây nguồn trong 2 giây thực tế có q=2. Đây không phải
benchmark hiện có. Audio TTS dài 8 giây trong đoạn nguồn 4 giây vẫn chưa hợp lệ
để phát đồng bộ, dù tính toán đã đủ nhanh.

Mốc thử nghiệm: chuẩn bị 10–15 giây timeline liên tục trước khi phát; giữ vùng
đọc trước 30–60 giây. Đây là dung lượng nội dung, không phải cam kết thời gian
chờ. Hết buffer phải pause/rebuffer; không bỏ câu để giữ video chạy trong chế độ
đồng bộ. Giữ lựa chọn pause của người dùng trong lúc rebuffer.

### Khớp câu và đồng hồ

Dịch theo cụm nghĩa có ngân sách thời lượng; synthesize, đo duration, co giãn
nhẹ có giữ cao độ. Nếu câu quá dài thì dịch gọn/tạo lại; không cắt mất nội dung
hoặc tăng tốc cực đoan. Forced alignment có thể cải thiện biên từ/câu nguồn,
nhưng không ánh xạ chính xác từ một-một giữa hai ngôn ngữ và không tạo lip-sync.
Video.currentTime là đồng hồ chính, không dùng thời gian request về để bắt đầu.

### Hosting đề xuất để benchmark

Giữ Modal để giảm thay đổi hạ tầng; thử L40S và H100 bên cạnh baseline L4/A10.
Worker model luôn sẵn sàng khi cần SLA, trọng số đã cache, warmup xong mới nhận
phiên; cấu hình min_containers làm tăng chi phí khi rảnh và chưa được bật.
Nếu tải ổn định, server GPU riêng chạy Docker và gateway WebSocket là lựa chọn
thứ hai. Chọn region theo RTT thực tế của người dùng và worker, không chỉ tên GPU.

Tách lịch chạy ASR câu n+1 / dịch câu n / TTS câu n-1; cache giọng và câu đã tạo.
Không tăng concurrency trên một Viterbox instance mutable. Dùng replica độc lập
hoặc scheduler được model hỗ trợ. Batching tăng throughput nhưng có thể tăng
thời gian chờ; phải giới hạn queue delay và đo p95 của phiên đang xem.

Ma trận benchmark: baseline/L40S/H100 × 1/4/8 phiên × warm/cold × câu ngắn/dài.
Đo source-ready throughput, TTS full-sentence latency, TTFA, queueMs, RTT,
startup buffer time, số lần rebuffer, drift và chi phí trên phút nguồn hoàn tất.
Chưa có benchmark chứng minh H100 hay B200 nhanh hơn bao nhiêu với stack này.
Không mua GPU trước khi kiểm tra phần mềm, CUDA và model tương thích.

Nguồn bổ sung (kiểm tra 24/09/2026):
- Modal GPU: https://modal.com/docs/guide/gpu
- Worker khởi động: https://modal.com/docs/guide/cold-start
- Triton giới hạn thời gian chờ batch: https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/batcher.html
- Forced alignment: https://github.com/m-bain/whisperX

Bổ sung này là thiết kế và kế hoạch đo, chưa triển khai nguồn đọc trước, thuê GPU,
hoặc đổi model production. Cổng quyết định đầu tiên là chứng minh truy cập được
nguồn tương lai trên tập video đại diện có và không có phụ đề.
