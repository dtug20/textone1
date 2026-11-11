"use client";

import { useEffect, useRef, useState } from "react";

export type SavedVideoSegment = {
    sequence: number;
    duration: number;
    sourceStart: number;
    speechStart?: number | null;
    speechEnd?: number | null;
    text: string;
    translatedText: string;
    video: string;
    audio: string | null;
};

type Player = {
    load: (clip: SavedVideoSegment & { volume: number }) => Promise<void>;
    play: () => Promise<void>;
    pause: () => void;
    destroy: () => void;
};

export function SavedVideoPlayer({ segments, title }: { segments: SavedVideoSegment[]; title: string }) {
    const video = useRef<HTMLVideoElement>(null); const audio = useRef<HTMLAudioElement>(null); const player = useRef<Player | null>(null);
    const [index, setIndex] = useState(0); const [playing, setPlaying] = useState(false); const [error, setError] = useState(""); const [ready, setReady] = useState(false); const [volume, setVolume] = useState(0.2);
    const autoplay = useRef(false); const indexRef = useRef(0);
    useEffect(() => {
        let cancelled = false;
        const path = "/dub-player.js";
        void import(/* webpackIgnore: true */ path).then((module: { DubPlayer: new (video: HTMLVideoElement, audio: HTMLAudioElement, onEnd: () => void) => Player }) => {
            if (cancelled || !video.current || !audio.current) return;
            player.current = new module.DubPlayer(video.current, audio.current, () => {
                if (indexRef.current < segments.length - 1) { autoplay.current = true; setIndex((value) => value + 1); }
                else { autoplay.current = false; setPlaying(false); }
            });
            setReady(true);
        }).catch(() => setError("Không tải được trình phát. Hãy tải lại trang."));
        return () => { cancelled = true; player.current?.destroy(); player.current = null; };
    }, [segments.length]);
    useEffect(() => {
        if (!ready || !player.current) return;
        let cancelled = false; indexRef.current = index; setError("");
        void player.current.load({ ...segments[index], volume: video.current?.volume ?? 0.2 }).then(async () => {
            if (cancelled) return;
            if (autoplay.current) { await player.current?.play(); setPlaying(true); }
        }).catch(() => { if (!cancelled) { setError("Không phát được đoạn này. Tải lại trang để cấp liên kết mới rồi thử lại."); setPlaying(false); } });
        return () => { cancelled = true; };
    }, [index, ready, segments]);
    async function toggle() {
        if (!player.current) return;
        if (playing) { player.current.pause(); setPlaying(false); autoplay.current = false; }
        else { try { await player.current.play(); setPlaying(true); autoplay.current = true; } catch { setError("Bấm Phát lần nữa để bật âm thanh."); } }
    }
    function downloadTranscript() {
        const text = segments.map((s) => `[${s.sourceStart.toFixed(1)}s]\n${s.text}\n${s.translatedText}`).join("\n\n");
        const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = `${title.slice(0, 80)}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return <section className="space-y-4"><div className="overflow-hidden rounded-xl bg-black"><video ref={video} playsInline className="aspect-video w-full" /><audio ref={audio} /></div><div className="flex flex-wrap items-center gap-3"><button disabled={!ready} onClick={toggle} className="rounded-lg bg-primary px-5 py-2.5 text-primary-foreground disabled:opacity-50">{playing ? "Tạm dừng" : "Phát video"}</button><label className="flex items-center gap-2 text-sm">Đoạn<select aria-label="Chọn đoạn" value={index} onChange={(e) => setIndex(Number(e.target.value))} className="rounded border p-2">{segments.map((s, i) => <option key={s.sequence} value={i}>{i + 1} · {Math.floor(s.sourceStart / 60)}:{String(Math.floor(s.sourceStart % 60)).padStart(2, "0")}</option>)}</select></label><label className="flex items-center gap-2 text-sm">Âm thanh gốc<input aria-label="Âm lượng gốc" type="range" min="0" max="1" step="0.05" value={volume} onChange={(e) => { const value = Number(e.target.value); setVolume(value); if (video.current) video.current.volume = value; }} /></label><button onClick={downloadTranscript} className="ml-auto rounded-lg border px-4 py-2 text-sm">Tải bản dịch</button></div>{error && <p role="alert" className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">{error}</p>}<div className="rounded-xl border bg-muted/30 p-5"><p className="mb-3 text-xs font-medium tracking-wider text-muted-foreground">BẢN DỊCH ĐANG PHÁT</p><p className="text-lg leading-relaxed">{segments[index].translatedText || "Đoạn này không có lời nói."}</p><details className="mt-4 text-sm text-muted-foreground"><summary>Lời nói gốc</summary><p className="mt-2">{segments[index].text}</p></details></div></section>;
}
