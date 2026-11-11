import { z } from "zod";
import { prisma } from "@/lib/db";
import { uploadAudio } from "@/lib/r2";
import { detectLanguage } from "@/lib/language-detection";
import { TEXT_MAX_LENGTH } from "@/features/text-to-speech/data/constants";

export const runtime = "nodejs";
export const maxDuration = 60;

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
};

const inputSchema = z.object({
    text: z.string().min(1).max(TEXT_MAX_LENGTH),
    voiceId: z.string().min(1),
    orgId: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).default(0.8),
    topP: z.number().min(0).max(1).default(0.95),
    topK: z.number().min(1).max(10000).default(1000),
    repetitionPenalty: z.number().min(1).max(2).default(1.2),
});

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
    if (parts.length === 1) return parts[0];
    const pcm = parts.map(part => {
        const marker = part.indexOf("data");
        const size = marker >= 0 ? part.readUInt32LE(marker + 4) : 0;
        return marker >= 0 ? part.subarray(marker + 8, marker + 8 + size) : part.subarray(44);
    });
    const body = Buffer.concat(pcm);
    const header = Buffer.from(parts[0].subarray(0, 44));
    header.writeUInt32LE(36 + body.length, 4);
    header.writeUInt32LE(body.length, 40);
    return Buffer.concat([header, body]);
}

export async function OPTIONS() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: Request) {
    try {
        const parsed = inputSchema.safeParse(await request.json());
        if (!parsed.success) {
            return Response.json({ error: "Invalid request payload" }, { status: 400, headers: CORS_HEADERS });
        }
        const input = parsed.data;
        const voice = await prisma.voice.findUnique({
            where: { id: input.voiceId },
            select: { id: true, name: true, language: true, orgId: true },
        });
        if (!voice) {
            return Response.json({ error: "Voice not found" }, { status: 404, headers: CORS_HEADERS });
        }

        let targetOrgId = input.orgId || voice.orgId;
        if (!targetOrgId) {
            const latest = await prisma.generation.findFirst({
                orderBy: { createdAt: "desc" },
                select: { orgId: true },
            });
            targetOrgId = latest?.orgId ?? null;
        }
        if (!targetOrgId) {
            return Response.json({ error: "Organization not found" }, { status: 400, headers: CORS_HEADERS });
        }

        const detectedLang = detectLanguage(input.text);
        const useVi = detectedLang === "vi" || voice.language.toLowerCase().startsWith("vi");
        const language = useVi ? "vi" : "en";
        const lengthScale = useVi ? 0.76 : 0.92;
        const fastTts = (process.env.FAST_TTS_API_URL || "http://192.168.1.198:18803").replace(/\/$/, "");

        const wavs: Buffer[] = [];
        for (const piece of spokenPieces(input.text)) {
            const res = await fetch(`${fastTts}/synthesize`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: piece, length_scale: lengthScale, language }),
            });
            if (!res.ok) {
                const detail = await res.text();
                return Response.json({ error: `LAN TTS error ${res.status}: ${detail}` }, { status: 502, headers: CORS_HEADERS });
            }
            wavs.push(Buffer.from(await res.arrayBuffer()));
        }

        const buffer = joinWav(wavs);
        if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
            return Response.json({ error: "LAN TTS returned invalid audio" }, { status: 502, headers: CORS_HEADERS });
        }

        const generation = await prisma.generation.create({
            data: {
                orgId: targetOrgId,
                text: input.text,
                voiceName: voice.name,
                voiceId: voice.id,
                engine: useVi ? "viterbox" : "chatterbox",
                detectedLang,
                temperature: input.temperature,
                topP: input.topP,
                topK: input.topK,
                repetitionPenalty: input.repetitionPenalty,
            },
            select: { id: true },
        });

        const r2ObjectKey = `generations/orgs/${targetOrgId}/${generation.id}`;
        await uploadAudio({ buffer, key: r2ObjectKey });
        await prisma.generation.update({
            where: { id: generation.id },
            data: { r2ObjectKey },
        });

        return Response.json(
            {
                id: generation.id,
                orgId: targetOrgId,
                engine: "piper-lan",
                language,
                audioBase64: buffer.toString("base64"),
            },
            { status: 200, headers: CORS_HEADERS },
        );
    } catch (error) {
        return Response.json(
            { error: error instanceof Error ? error.message : "LAN TTS synthesis failed" },
            { status: 500, headers: CORS_HEADERS },
        );
    }
}

