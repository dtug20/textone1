import Link from "next/link";

export type VideoSummaryItem = {
    id: string;
    title: string;
    source: string;
    target: string;
    createdAt: Date;
    _count: { segments: number };
};

export function VideosView({ videos }: { videos: VideoSummaryItem[] }) {
    return <main className="mx-auto w-full max-w-6xl space-y-8 p-6 lg:p-12">
        <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm text-muted-foreground">TEXTONE · THƯ VIỆN</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Video đã dịch</h1><p className="mt-3 max-w-2xl text-muted-foreground">Xem lại hình, giọng thuyết minh và bản dịch đã lưu từ extension. Mỗi video gồm phần đã thu trong phiên, kể cả khi bạn dừng giữa chừng.</p></div><Link className="rounded-lg bg-primary px-5 py-3 text-sm text-primary-foreground" href="/realtime">Tạo phiên dịch mới</Link></header>
        {videos.length === 0 ? <section className="rounded-2xl border border-dashed p-12 text-center"><h2 className="text-xl font-medium">Chưa có video được lưu</h2><p className="mt-3 text-muted-foreground">Bật “Lưu hình và bản dịch” trong extension trước khi bắt đầu thuyết minh.</p></section> : <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{videos.map((video) => <Link href={`/videos/${video.id}`} key={video.id} className="rounded-xl border bg-card p-5 transition hover:border-primary hover:shadow-sm"><div className="mb-5 flex aspect-video items-center justify-center rounded-lg bg-muted text-3xl text-primary" aria-hidden>▶</div><h2 className="line-clamp-2 font-semibold">{video.title}</h2><p className="mt-3 text-sm text-muted-foreground">{video.source.toUpperCase()} → {video.target.toUpperCase()} · {video._count.segments} đoạn đã lưu</p><p className="mt-2 text-xs text-muted-foreground">{video.createdAt.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</p></Link>)}</div>}
        {videos.length === 100 && <p className="text-sm text-muted-foreground">Đang hiển thị 100 video gần nhất.</p>}
    </main>;
}
