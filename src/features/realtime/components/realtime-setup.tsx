"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export type RealtimeVoiceOption = {
    id: string;
    name: string;
    language: string;
};

export function RealtimeSetup({ voices }: { voices: RealtimeVoiceOption[] }) {
    const [mode, setMode] = useState("dub");
    const [source, setSource] = useState("en");
    const [target, setTarget] = useState("vi");
    const [voiceId, setVoiceId] = useState(voices.find((voice) => voice.language.startsWith("vi"))?.id ?? "");
    const [cloneVoice, setCloneVoice] = useState(false);
    const [token, setToken] = useState("");
    const [expires, setExpires] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    async function createSession() {
        setBusy(true); setError(""); setToken("");
        try {
            const response = await fetch("/api/realtime/session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode, source, target, voiceId, ...(mode === "dub" ? { cloneVoice } : {}) }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Không thể tạo phiên");
            setToken(result.token); setExpires(new Date(result.expires).toLocaleTimeString());
        } catch (error) { setError(error instanceof Error ? error.message : "Không thể kết nối"); }
        finally { setBusy(false); }
    }

    const field = "mt-2 block w-full rounded-md border bg-background p-3";
    return <main className="mx-auto w-full max-w-3xl space-y-6 p-6 md:p-10">
        <div><p className="text-sm text-muted-foreground">TEXTONE · BETA</p><h1 className="mt-2 text-3xl font-semibold">Nghe, chép lời và thuyết minh</h1><p className="mt-3 text-muted-foreground">TexTone đọc phụ đề của video YouTube đang phát, dịch từng câu đủ nghĩa và phát giọng xong trước khi câu nói tiếp theo bắt đầu.</p></div>
        <section className="space-y-5 rounded-xl border p-6">
            <label className="block">Chế độ<select className={field} value={mode} onChange={(e) => setMode(e.target.value)}><option value="dub">Dịch và thuyết minh</option><option value="transcribe">Chỉ speech-to-text</option></select></label>
            <div className="grid gap-4 sm:grid-cols-2"><label>Ngôn ngữ nguồn<select className={field} value={source} onChange={(e) => setSource(e.target.value)}><option value="en">English</option><option value="vi">Tiếng Việt</option></select></label>
            <label>Ngôn ngữ thuyết minh<select disabled={mode === "transcribe"} className={field} value={target} onChange={(e) => { setTarget(e.target.value); setVoiceId(voices.find((voice) => voice.language.startsWith(e.target.value))?.id ?? ""); }}><option value="vi">Tiếng Việt</option><option value="en">English</option></select></label></div>
            {mode === "dub" && <label className="block">Giọng đọc<select className={field} value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>{voices.filter((voice) => voice.language.startsWith(target)).map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {voice.language}</option>)}</select></label>}
            {mode === "dub" && <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
                <label className="flex cursor-pointer items-center gap-3 font-medium">
                    <input type="checkbox" className="size-4 accent-primary" checked={cloneVoice} onChange={(e) => setCloneVoice(e.target.checked)} />
                    <span>Clone giọng nói của chính người đang nói trong video</span>
                </label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                    <strong>Khuyến cáo:</strong> Chức năng clone giọng trực tiếp từ video hoạt động tốt nhất với <strong>video độc thoại 1 người nói</strong> rõ tiếng (bài giảng, thuyết trình, vlog cá nhân, ít nhạc nền) để giọng dịch giữ ổn định theo đúng tông giọng của diễn giả. Với video hội thoại nhiều người hoặc nhiều tạp âm, nên tắt chức năng này để dùng giọng đọc cố định.
                </p>
            </div>}
            <p className="text-sm text-muted-foreground">Phiên có hiệu lực 15 phút và dùng cài đặt tại thời điểm tạo. Tạo phiên mới sẽ thay thế phiên cũ của tổ chức. Âm thanh chỉ được gửi khi bạn bấm Bắt đầu trong extension. Bật “Lưu hình và bản dịch” trong popup để lưu phần video đã dịch vào thư viện riêng của tổ chức.</p>
            <Button disabled={busy || (mode === "dub" && !voiceId)} onClick={createSession}>{busy ? "Đang tạo…" : "Tạo mã phiên extension"}</Button>
            {error && <p role="alert" className="text-destructive">{error}</p>}
            {token && <div className="space-y-3"><p>Mã hết hạn lúc {expires} hoặc sau 300 đoạn xử lý. Dán lại mã này vào extension rồi bấm Bắt đầu. Mã cũ đã bị thay thế; extension không tự cập nhật mã.</p><textarea aria-label="Mã phiên" readOnly value={token} className={field} rows={3} /><Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(token); } catch { setError("Không thể sao chép tự động. Hãy chọn và sao chép mã phiên."); } }}>Sao chép mã</Button></div>}
        </section>
        <section className="rounded-xl border p-6"><h2 className="text-lg font-semibold">Kiểm thử với extension 0.9.5</h2><ol className="mt-3 list-decimal space-y-2 pl-5"><li>Tại chrome://extensions, bấm Reload TexTone và kiểm tra popup ghi 0.9.5. Tải lại tab YouTube.</li><li>Tạo mã phiên trên trang này: nguồn English, thuyết minh Tiếng Việt, chế độ Dịch và thuyết minh. Sao chép mã.</li><li>Mở video YouTube công khai có phụ đề tiếng Anh, không phải live. Popup TexTone dùng máy chủ https://textone.id.vn; dán mã rồi bấm Bắt đầu thuyết minh.</li><li>Video chạy khi câu đầu đã có giọng. Mỗi câu dịch phải hết trước khi người nói sang câu sau. Tua hoặc dừng trên YouTube; bấm Dừng trong popup để kết thúc.</li></ol><p className="mt-4 text-sm text-muted-foreground">Chrome 116+. Trình phát YouTube giữ nguyên, không mở tab mới. Nếu video không có phụ đề tiếng Anh, extension chuyển sang nghe âm thanh tab. Đây là đồng bộ theo câu phụ đề, không phải khẩu hình.</p></section>
    </main>;
}
