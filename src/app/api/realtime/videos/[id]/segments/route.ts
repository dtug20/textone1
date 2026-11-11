import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { uploadAudio, deleteAudio } from "@/lib/r2";
import { boundedBody, videoSession } from "@/lib/realtime/video-auth";
export const runtime = "nodejs";
export const maxDuration = 30;
const schema = z.object({ sequence: z.number().int().min(0).max(299), sourceStart: z.number().min(0).max(86400), duration: z.number().positive().max(6), text: z.string().max(1500), translation: z.string().max(1500), speechStart: z.number().min(0).optional(), speechEnd: z.number().positive().optional() }).refine((value) => (value.speechStart === undefined && value.speechEnd === undefined) || (value.speechStart !== undefined && value.speechEnd !== undefined && value.speechEnd > value.speechStart && value.speechEnd <= value.duration));
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    const session = await videoSession(request);
    if (!session) return Response.json({ error: "Phiên lưu đã hết hạn." }, { status: 401 });
    const { id } = await context.params;
    const owner = await prisma.translatedVideo.findFirst({ where: { id, orgId: session.orgId, sessionId: session.id }, select: { id: true } });
    if (!owner) return Response.json({ error: "Không tìm thấy video." }, { status: 404 });
    let form: FormData;
    try {
        const bytes = await boundedBody(request, 3_500_000);
        form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData();
    } catch { return Response.json({ error: "Đoạn video quá lớn hoặc không hợp lệ." }, { status: 413 }); }
    const metadata = schema.safeParse(await Promise.resolve().then(() => JSON.parse(typeof form.get("metadata") === "string" ? form.get("metadata") as string : "null")).catch(() => null));
    const video = form.get("video"); const speech = form.get("audio");
    if (!metadata.success || !(video instanceof File) || video.size < 4 || video.size > 2_000_000 || (speech !== null && (!(speech instanceof File) || speech.size > 1_400_000))) return Response.json({ error: "Đoạn video không hợp lệ." }, { status: 400 });
    const videoBytes = Buffer.from(await video.arrayBuffer());
    const audioBytes = speech instanceof File ? Buffer.from(await speech.arrayBuffer()) : null;
    if (videoBytes.readUInt32BE(0) !== 0x1a45dfa3 || (audioBytes && (audioBytes.length < 44 || audioBytes.toString("ascii", 0, 4) !== "RIFF" || audioBytes.toString("ascii", 8, 12) !== "WAVE"))) return Response.json({ error: "Định dạng video/âm thanh không hợp lệ." }, { status: 400 });
    const where = { videoId_sequence: { videoId: id, sequence: metadata.data.sequence } };
    if (await prisma.translatedVideoSegment.findUnique({ where })) return Response.json({ ok: true });
    const prefix = `translated/${session.orgId}/${id}/${randomUUID()}`;
    const videoKey = `${prefix}.webm`; const audioKey = audioBytes ? `${prefix}.wav` : null;
    try {
        await Promise.all([uploadAudio({ buffer: videoBytes, key: videoKey, contentType: "video/webm" }), audioBytes && audioKey ? uploadAudio({ buffer: audioBytes, key: audioKey }) : null]);
        await prisma.translatedVideoSegment.create({ data: { videoId: id, ...metadata.data, videoKey, audioKey } });
        return Response.json({ ok: true });
    } catch {
        await Promise.allSettled([deleteAudio(videoKey), ...(audioKey ? [deleteAudio(audioKey)] : [])]);
        if (await prisma.translatedVideoSegment.findUnique({ where })) return Response.json({ ok: true });
        return Response.json({ error: "Chưa lưu được đoạn video. Hãy thử lại." }, { status: 503 });
    }
}
