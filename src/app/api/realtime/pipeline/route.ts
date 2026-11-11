import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { videoSession, boundedBody } from '@/lib/realtime/video-auth';

export const runtime = 'nodejs';
const schema = z.object({ action: z.enum(['acquire', 'renew', 'release']), lease: z.string().datetime().optional(), reserve: z.boolean().default(false) });
export async function GET(request: Request) {
    if (!await videoSession(request)) return Response.json({ error: 'Phiên đã hết hạn hoặc bị thay thế.' }, { status: 401 });
    const endpoint = process.env.REALTIME_PIPELINE_URL;
    if (!endpoint) return Response.json({ error: 'Máy chủ pipeline chưa được triển khai.' }, { status: 503 });
    return Response.json({ endpoint }, { headers: { 'Cache-Control': 'no-store' } });
}
// Worker-only lease protocol. Browser never receives the service API key or voice path.
export async function POST(request: Request) {
    const actual = Buffer.from(request.headers.get('x-api-key') || '');
    const expected = Buffer.from(env.CHATTERBOX_API_KEY);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: 'Forbidden' }, { status: 403 });
    const session = await videoSession(request);
    if (!session) return Response.json({ error: 'Phiên đã hết hạn hoặc bị thay thế.' }, { status: 401 });
    const input = schema.safeParse(await boundedBody(request, 2048).then(b => JSON.parse(b.toString())).catch(() => null));
    if (!input.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
    const { action, lease, reserve } = input.data;
    if (action !== 'acquire' && !lease) return Response.json({ error: 'Lease required' }, { status: 400 });
    const increment = action === 'acquire' || (action === 'renew' && reserve) ? 5 : 0;
    // Millisecond lease identity changes on every renewal; cleanup is compare-and-set.
    const until = action === 'release' ? new Date() : new Date(Date.now() + 120_000 + Math.floor(Math.random() * 1000));
    const voice = action === 'acquire' && session.mode === 'dub'
        ? await prisma.voice.findFirst({ where: { id: session.voiceId, OR: [{ variant: 'SYSTEM' }, { variant: 'CUSTOM', orgId: session.orgId }] }, select: { r2ObjectKey: true } }) : null;
    if (action === 'acquire' && session.mode === 'dub' && !voice) return Response.json({ error: 'Voice unavailable' }, { status: 404 });
    const updated = await prisma.realtimeSession.updateMany({
        where: { id: session.id, orgId: session.orgId, expiresAt: { gt: new Date() },
            nextAllowedAt: action === 'acquire' ? { lte: new Date() } : new Date(lease!),
            ...(increment ? { chunks: { lte: 300 - increment } } : {}) },
        data: { nextAllowedAt: until, ...(increment ? { chunks: { increment } } : {}) },
    });
    if (!updated.count) return Response.json({ error: 'Phiên đang bận, đã bị thay thế hoặc hết hạn mức. Dừng phiên cũ hoặc tạo mã mới.' }, { status: 409 });
    return Response.json({ lease: until.toISOString(), budget: increment,
        ...(action === 'acquire' ? { source: session.source, target: session.target, mode: session.mode, voice: voice?.r2ObjectKey, expires: session.expires, ...(session.cloneVoice ? { cloneVoice: true } : {}) } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
}
