import { env } from "@/lib/env";
import { videoSession } from "@/lib/realtime/video-auth";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(request: Request) {
    const session = await videoSession(request);
    if (!session) return Response.json({ error: "Mã phiên đã hết hạn hoặc bị thay thế." }, { status: 401 });
    const urls = [process.env.REALTIME_API_URL];
    const fastTts = process.env.FAST_TTS_API_URL;
    if (session.mode === "dub") urls.push(fastTts || (session.target === "vi" ? env.VITERBOX_API_URL : env.CHATTERBOX_API_URL));
    try {
        await Promise.all(urls.map(async (url) => {
            if (!url) throw new Error("Missing endpoint");
            const response = await fetch(`${url.replace(/\/$/, "")}/health`, { headers: { "x-api-key": env.CHATTERBOX_API_KEY }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(110_000)]) });
            await response.body?.cancel();
            if (!response.ok) throw new Error("Model not ready");
        }));
        return Response.json({ ready: true }, { headers: { "Cache-Control": "no-store" } });
    } catch { return Response.json({ error: "GPU chưa sẵn sàng. Hãy thử kết nối lại." }, { status: 503 }); }
}
