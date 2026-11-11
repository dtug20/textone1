import { z } from "zod";
import { prisma } from "@/lib/db";
import { boundedBody, videoSession } from "@/lib/realtime/video-auth";
export const runtime = "nodejs";
const schema = z.object({ title: z.string().min(1).max(300), sourceUrl: z.url().max(2048).refine((url) => /^https?:\/\//.test(url)) });
export async function POST(request: Request) {
    const session = await videoSession(request);
    if (!session) return Response.json({ error: "Phiên đã hết hạn hoặc bị thay thế." }, { status: 401 });
    const input = schema.safeParse(await boundedBody(request, 4096).then((b) => JSON.parse(b.toString())).catch(() => null));
    if (!input.success) return Response.json({ error: "Thông tin video không hợp lệ." }, { status: 400 });
    const video = await prisma.translatedVideo.upsert({
        where: { sessionId: session.id }, update: {},
        create: { sessionId: session.id, orgId: session.orgId, source: session.source, target: session.target, ...input.data },
        select: { id: true },
    });
    return Response.json(video, { headers: { "Cache-Control": "no-store" } });
}
