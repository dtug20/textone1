import { z } from "zod";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { verifySession } from "@/lib/realtime/session";

function spokenPieces(text: string) {
    const limit = 900;
    const pieces: string[] = [];
    let rest = text.trim();
    while (rest.length > limit) {
        const cut = Math.max(rest.lastIndexOf("\n", limit), rest.lastIndexOf(". ", limit), rest.lastIndexOf(" ", limit));
        const at = cut > 0 ? cut : limit;
        pieces.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
    return pieces;
}
function joinWav(parts: Buffer[]) {
    const valid = parts.filter(part => part.length >= 44 && part.toString("ascii", 0, 4) === "RIFF");
    if (!valid.length) return Buffer.alloc(0);
    if (valid.length === 1) return valid[0];
    const pcm = valid.map(part => {
        const marker = part.indexOf("data");
        const size = marker >= 0 ? part.readUInt32LE(marker + 4) : 0;
        return marker >= 0 ? part.subarray(marker + 8, marker + 8 + size) : part.subarray(44);
    });
    const body = Buffer.concat(pcm);
    const header = Buffer.from(valid[0].subarray(0, 44));
    header.writeUInt32LE(36 + body.length, 4);
    header.writeUInt32LE(body.length, 40);
    return Buffer.concat([header, body]);
}

export const runtime = "nodejs";
export const maxDuration = 120;
const resultSchema = z.object({ text: z.string().max(1500), translatedText: z.string().max(1500),
    speechStart: z.number().min(0).max(6).nullable().optional(),
    speechEnd: z.number().min(0).max(6).nullable().optional(),
    modelTimings: z.object({ queueMs: z.number().nonnegative(), asrMs: z.number().nonnegative(), translationMs: z.number().nonnegative() }).optional(),
});

export async function POST(request: Request) {
    let session: ReturnType<typeof verifySession>;
    try {
        session = verifySession(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "", process.env.REALTIME_SESSION_SECRET ?? "");
    } catch { return Response.json({ code: "SESSION_INVALID", error: "Mã phiên không hợp lệ hoặc đã hết hạn. Tạo mã mới tại /realtime và dán lại vào extension." }, { status: 401 }); }
    const endpoint = process.env.REALTIME_API_URL;
    if (!endpoint) return Response.json({ error: "Realtime service unavailable" }, { status: 503 });
    // Only accept bounded PCM WAV chunks. No multipart buffering of arbitrary uploads.
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "Audio required" }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000_000) { await reader.cancel(); return Response.json({ error: "Audio too large" }, { status: 413 }); }
        chunks.push(value);
    }
    const audio = Buffer.concat(chunks);
    if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") return Response.json({ error: "PCM WAV required" }, { status: 400 });
    // Atomic database lease works across serverless instances and bounds GPU usage.
    const leaseUntil = new Date(Date.now() + 120_000);
    const lease = await prisma.realtimeSession.updateMany({
        where: { id: session.id, orgId: session.orgId, expiresAt: { gt: new Date() }, nextAllowedAt: { lte: new Date() }, chunks: { lt: 300 } },
        data: { nextAllowedAt: leaseUntil, chunks: { increment: 1 } },
    });
    if (!lease.count) {
        // Read only on contention; successful chunks still acquire in one round trip.
        const stored = await prisma.realtimeSession.findFirst({ where: { id: session.id, orgId: session.orgId } });
        if (!stored) return Response.json({ code: "SESSION_REVOKED", error: "Mã phiên đã bị thay thế hoặc không còn tồn tại. Sao chép mã mới nhất tại /realtime và dán lại vào extension." }, { status: 401 });
        if (stored.expiresAt.getTime() <= Date.now()) return Response.json({ code: "SESSION_EXPIRED", error: "Phiên đã hết hạn. Tạo mã mới tại /realtime." }, { status: 401 });
        if (stored.chunks >= 300) return Response.json({ code: "SESSION_EXHAUSTED", error: "Phiên đã dùng hết 300 đoạn âm thanh. Tạo mã mới tại /realtime." }, { status: 409 });
        return Response.json({ code: "SESSION_BUSY", error: "Phiên đang xử lý âm thanh. Extension sẽ tự kết nối lại." }, { status: 429, headers: { "Retry-After": "1" } });
    }
    const started = performance.now();
    const disconnected = new AbortController();
    const signal = AbortSignal.any([request.signal, disconnected.signal, AbortSignal.timeout(105_000)]);
    type SpeechResult = z.infer<typeof resultSchema>;
    type Event = Record<string, unknown>;
    async function processChunk(emit: (event: Event) => void = () => {}) {
        let recognized: SpeechResult | null = null;
        let sttMs = 0;
        let stage = "recognizing";
        try {
            emit({ type: "progress", stage });
            const vi = session.target === "vi";
            const fastTts = process.env.FAST_TTS_API_URL?.replace(/\/$/, "") ?? "";
            const ttsEndpoint = (fastTts || (vi ? env.VITERBOX_API_URL : env.CHATTERBOX_API_URL)).replace(/\/$/, "");
            // Start both cold containers together. Never make transcript delivery wait for TTS.
            const warmup = session.mode === "dub" && request.headers.get("x-textone-prepared") !== "1"
                ? fetch(`${ttsEndpoint}/health`, { headers: { "x-api-key": env.CHATTERBOX_API_KEY }, signal })
                    .then(async (response) => { await response.body?.cancel(); }).catch(() => {})
                : Promise.resolve();
            const url = new URL(`${endpoint!.replace(/\/$/, "")}/process`);
            url.searchParams.set("source", session.source);
            url.searchParams.set("target", session.mode === "dub" ? session.target : session.source);
            const [response, voice] = await Promise.all([
                fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav", "x-api-key": env.CHATTERBOX_API_KEY }, body: audio, signal }),
                session.mode === "dub" ? prisma.voice.findFirst({ where: { id: session.voiceId, OR: [{ variant: "SYSTEM" }, { variant: "CUSTOM", orgId: session.orgId }] }, select: { r2ObjectKey: true } }) : null,
            ]);
            if (!response.ok) throw new Error(`STT_HTTP_${response.status}`);
            recognized = resultSchema.parse(await response.json());
            sttMs = Math.round(performance.now() - started);
            emit({ type: "transcript", ...recognized, timings: { sttMs } });
            let wav: string | null = null;
            let ttsMs = 0;
            if (session.mode === "dub" && recognized.translatedText.trim()) {
                stage = "synthesizing";
                emit({ type: "progress", stage });
                if (!voice?.r2ObjectKey) throw new Error("VOICE_UNAVAILABLE");
                const ttsStarted = performance.now();
                await warmup;
                const pieces = fastTts ? spokenPieces(recognized.translatedText) : [recognized.translatedText];
                const wavs: Buffer[] = [];
                const cloneFields = session.cloneVoice
                    ? { clone_voice: true, reference_audio: audio.toString("base64") }
                    : {};
                for (const text of pieces) {
                    const tts = await fetch(`${ttsEndpoint}/${fastTts ? "synthesize" : "generate"}`, {
                        method: "POST", signal,
                        headers: { "Content-Type": "application/json", ...(fastTts ? {} : { "x-api-key": env.CHATTERBOX_API_KEY }) },
                        body: JSON.stringify(fastTts
                            ? (vi ? { text, length_scale: 0.76, ...cloneFields } : { text, length_scale: 0.92, language: "en", ...cloneFields })
                            : { prompt: text, voice_key: voice.r2ObjectKey, ...(vi ? { language: "vi", sentence_pause_ms: 100, crossfade_ms: 20, split_sentences: false } : {}) }),
                    });
                    if (!tts.ok) throw new Error(`TTS_HTTP_${tts.status}`);
                    wavs.push(Buffer.from(await tts.arrayBuffer()));
                }
                const bytes = joinWav(wavs);
                if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") throw new Error("TTS_INVALID_AUDIO");
                wav = bytes.toString("base64");
                ttsMs = Math.round(performance.now() - ttsStarted);
            }
            return { status: 200, payload: { ...recognized, audio: wav, timings: { sttMs, ttsMs, totalMs: Math.round(performance.now() - started) } } };
        } catch (error) {
            console.warn("realtime_chunk_failed", { stage, reason: signal.aborted ? "timeout_or_cancelled" : error instanceof Error ? error.message : "unknown", totalMs: Math.round(performance.now() - started) });
            // A TTS outage must not erase a successfully recognized/translated segment.
            if (recognized) return { status: 200, payload: { ...recognized, audio: null, warning: "Đã chép lời và dịch, nhưng giọng đọc chưa sẵn sàng. Đang tiếp tục nghe.", code: signal.aborted ? "TTS_TIMEOUT" : "TTS_FAILED", timings: { sttMs, totalMs: Math.round(performance.now() - started) } } };
            return { status: signal.aborted ? 504 : 502, payload: { code: "STT_FAILED", error: "Dịch vụ nhận dạng chưa phản hồi. Đang thử lại.", retryable: true } };
        } finally {
            disconnected.abort();
            // A delayed request must never release a newer request's lease.
            await prisma.realtimeSession.updateMany({ where: { id: session.id, nextAllowedAt: leaseUntil }, data: { nextAllowedAt: new Date() } });
        }
    }
    if (!request.headers.get("accept")?.includes("application/x-ndjson")) {
        const { status, payload } = await processChunk();
        return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
    }
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            const emit = (event: Event) => { if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
            void processChunk(emit).then(({ status, payload }) => {
                emit({ type: status === 200 ? "result" : "error", ...payload });
                if (!cancelled) controller.close();
            }).catch(() => {
                emit({ type: "error", error: "Không thể hoàn tất phiên xử lý. Đang thử lại.", retryable: true });
                if (!cancelled) controller.close();
            });
        },
        cancel() { cancelled = true; disconnected.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
