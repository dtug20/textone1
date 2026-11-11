import { prisma } from "@/lib/db";
import { verifySession } from "./session";

export async function videoSession(request: Request) {
    try {
        const claims = verifySession(request.headers.get("authorization")?.replace(/^Bearer /, "") || "", process.env.REALTIME_SESSION_SECRET || "");
        const session = await prisma.realtimeSession.findFirst({ where: { id: claims.id, orgId: claims.orgId, expiresAt: { gt: new Date() } } });
        return session ? claims : null;
    } catch { return null; }
}

export async function boundedBody(request: Request, limit: number) {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Empty body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) { await reader.cancel(); throw new Error("Body too large"); }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}
