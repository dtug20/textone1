import Link from "next/link";
import { SavedVideoPlayer, type SavedVideoSegment } from "../components/saved-video-player";

export type VideoDetailData = {
    id: string;
    title: string;
    source: string;
    target: string;
    sourceUrl: string;
};

export function VideoDetailView({ video, segments }: { video: VideoDetailData; segments: SavedVideoSegment[] }) {
    return <main className="mx-auto w-full max-w-6xl space-y-6 p-5 lg:p-10">
        <Link href="/videos" className="text-sm text-muted-foreground">← Thư viện video</Link>
        <header>
            <h1 className="text-2xl font-semibold tracking-tight">{video.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{video.source.toUpperCase()} → {video.target.toUpperCase()} · {segments.length} đoạn đã lưu · <a href={video.sourceUrl} target="_blank" rel="noreferrer" className="underline">Mở video nguồn</a></p>
        </header>
        {segments.length ? <SavedVideoPlayer segments={segments} title={video.title} /> : <div className="rounded-xl border p-8"><p>Chưa có đoạn video được lưu. Phiên có thể đang khởi động hoặc xử lý đoạn đầu.</p><Link href={`/videos/${video.id}`} className="mt-4 inline-block underline">Tải lại trang</Link></div>}
        <p className="text-xs leading-6 text-muted-foreground">Chỉ hiển thị phần đã thu trong phiên. Tiếng và hình đồng bộ theo đoạn; hình phát chậm lại khi giọng dịch dài hơn. Liên kết phát có hiệu lực 1 giờ, tải lại trang nếu cần.</p>
    </main>;
}
