import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { issueSession, verifySession } from "@/lib/realtime/session";

export const runtime = "nodejs";
const schema = z.object({ voiceId: z.string().default(""), source: z.enum(["en", "vi"]), target: z.enum(["en", "vi"]), mode: z.enum(["transcribe", "dub"]), cloneVoice: z.boolean().optional() });
export async function POST(request: Request) {
    const { userId, orgId } = await auth();
    if (!userId || !orgId) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid origin" }, { status: 403 });
    const input = schema.safeParse(await request.json().catch(() => null));
    if (!input.success) return Response.json({ error: "Invalid settings" }, { status: 400 });
    const secret = process.env.REALTIME_SESSION_SECRET;
    if (!secret || secret.length < 32 || !process.env.REALTIME_API_URL) return Response.json({ error: "Realtime service is not configured" }, { status: 503 });
    if (input.data.mode === "dub") {
        const voice = await prisma.voice.findFirst({ where: { id: input.data.voiceId, OR: [{ variant: "SYSTEM" }, { variant: "CUSTOM", orgId }] } });
        if (!voice?.r2ObjectKey) return Response.json({ error: "Voice unavailable" }, { status: 404 });
    }
    const { cloneVoice, ...rest } = input.data;
    const issued = issueSession({ ...rest, ...(cloneVoice && rest.mode === "dub" ? { cloneVoice: true } : {}), orgId, userId }, secret);
    const claims = verifySession(issued.token, secret);
    // A new session revokes earlier capabilities for this organization.
    const data = { id: claims.id, orgId, expiresAt: new Date(issued.expires), nextAllowedAt: new Date(), chunks: 0 };
    await prisma.realtimeSession.upsert({ where: { orgId }, create: data, update: data });
    return Response.json(issued, { headers: { "Cache-Control": "no-store" } });
}
