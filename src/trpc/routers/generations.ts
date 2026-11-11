import * as Sentry from '@sentry/node';
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { uploadAudio } from "@/lib/r2";
import { detectLanguage, isMixedLanguage } from "@/lib/language-detection";
import { TEXT_MAX_LENGTH } from "@/features/text-to-speech/data/constants";
import { createTRPCRouter, orgProcedure } from "../init";

export const generationsRouter = createTRPCRouter({
    getById: orgProcedure
        .input(z.object({ id: z.string() }))
        .query(async ({ input, ctx }) => {
            const generation = await prisma.generation.findUnique({
                where: {
                    id: input.id,
                    orgId: ctx.orgId,
                },
                omit: {
                    orgId: true,
                },
            });

            if (!generation) throw new TRPCError({ code: "NOT_FOUND" });

            return {
                ...generation,
                audioUrl: `${env.NEXT_PUBLIC_R2_PUBLIC_URL}/${generation.r2ObjectKey}`,
            };
        }),

    getAll: orgProcedure.query(async ({ ctx }) => {
        const generations = await prisma.generation.findMany({
            where: { orgId: ctx.orgId },
            orderBy: { createdAt: "desc" },
            omit: {
                orgId: true,
                r2ObjectKey: true,
            },
        });

        return generations;
    }),

    create: orgProcedure
        .input(
            z.object({
                text: z.string().min(1).max(TEXT_MAX_LENGTH),
                voiceId: z.string().min(1),
                temperature: z.number().min(0).max(2).default(0.8),
                topP: z.number().min(0).max(1).default(0.95),
                topK: z.number().min(1).max(10000).default(1000),
                repetitionPenalty: z.number().min(1).max(2).default(1.2),
            })
        )
        .mutation(async ({ input, ctx }) => {
            const voice = await prisma.voice.findUnique({
                where: {
                    id: input.voiceId,
                    OR: [
                        { variant: "SYSTEM" },
                        { variant: "CUSTOM", orgId: ctx.orgId, }
                    ],
                },
                select: {
                    id: true,
                    name: true,
                    r2ObjectKey: true,
                    language: true,
                },
            });

            if (!voice) throw new TRPCError({
                code: "NOT_FOUND",
                message: "Voice not found"
            });

            if (!voice.r2ObjectKey) {
                throw new TRPCError({
                    code: "PRECONDITION_FAILED",
                    message: "Voice is not available.",
                });
            }

            // ── Language detection (server-side, authoritative) ─────────────
            const detectedLang = detectLanguage(input.text);
            const isMixed = isMixedLanguage(input.text);
            const useViterbox = detectedLang === "vi" || voice.language.toLowerCase().startsWith("vi");

            Sentry.logger.info("Generation started", {
                orgId: ctx.orgId,
                voiceId: input.voiceId,
                textLength: input.text.length,
                engine: useViterbox ? "viterbox" : "chatterbox",
                detectedLang,
                isMixed,
            });

            // ── Route to the correct TTS service ────────────────────────────
            const audioBuffer = useViterbox
                ? await callViterbox(input.text, voice.r2ObjectKey, input)
                : await callChatterbox(input.text, voice.r2ObjectKey, input);

            const buffer = Buffer.from(audioBuffer);
            let generationId: string | null = null;
            let r2ObjectKey: string | null = null;

            try {
                const generation = await prisma.generation.create({
                    data: {
                        orgId: ctx.orgId,
                        text: input.text,
                        voiceName: voice.name,
                        voiceId: voice.id,
                        engine: useViterbox ? "viterbox" : "chatterbox",
                        detectedLang,
                        temperature: input.temperature,
                        topP: input.topP,
                        topK: input.topK,
                        repetitionPenalty: input.repetitionPenalty,
                    },
                    select: {
                        id: true,
                    },
                });

                generationId = generation.id;
                r2ObjectKey = `generations/orgs/${ctx.orgId}/${generation.id}`;

                await uploadAudio({
                    buffer,
                    key: r2ObjectKey,
                });

                await prisma.generation.update({
                    where: { id: generationId },
                    data: { r2ObjectKey },
                });

                Sentry.logger.info("Audio generated", {
                    orgId: ctx.orgId,
                    generationId: generation.id,
                    engine: useViterbox ? "viterbox" : "chatterbox",
                    detectedLang,
                });
            } catch {
                if (generationId) {
                    await prisma.generation
                        .delete({
                            where: { id: generationId },
                        })
                        .catch(() => { });
                }

                Sentry.logger.error("Generation failed", {
                    orgId: ctx.orgId,
                    voiceId: input.voiceId,
                    engine: useViterbox ? "viterbox" : "chatterbox",
                });

                throw new TRPCError({
                    code: "INTERNAL_SERVER_ERROR",
                    message: "Failed to store generated audio",
                });
            }

            if (!generationId || !r2ObjectKey) throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: "Failed to store generated audio",
            });

            return { id: generationId };
        }),
});

// ── Chatterbox Turbo (English-optimized) ────────────────────────────────────
async function callChatterbox(
    text: string,
    voiceKey: string,
    params: { temperature: number; topP: number; topK: number; repetitionPenalty: number },
): Promise<ArrayBuffer> {
    const fastTts = process.env.FAST_TTS_API_URL?.replace(/\/$/, "");
    if (fastTts) {
        try {
            return await synthesizeWithPiper(fastTts, text, "en");
        } catch {
            // Fall back to public cloud endpoint when LAN host is unreachable.
        }
    }
    const res = await fetch(`${env.CHATTERBOX_API_URL}/generate`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": env.CHATTERBOX_API_KEY,
        },
        body: JSON.stringify({
            prompt: text,
            voice_key: voiceKey,
            temperature: params.temperature,
            top_p: params.topP,
            top_k: params.topK,
            repetition_penalty: params.repetitionPenalty,
            norm_loudness: true,
        }),
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Chatterbox error ${res.status}: ${detail}`,
        });
    }

    return res.arrayBuffer();
}

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

async function synthesizeWithPiper(endpoint: string, text: string, language: "vi" | "en" = "vi"): Promise<ArrayBuffer> {
    const wavs: Buffer[] = [];
    const lengthScale = language === "vi" ? 0.76 : 0.92;
    for (const piece of spokenPieces(text)) {
        const res = await fetch(`${endpoint}/synthesize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: piece, length_scale: lengthScale, language }),
        });
        if (!res.ok) {
            const detail = await res.text();
            throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: `TTS error ${res.status}: ${detail}`,
            });
        }
        wavs.push(Buffer.from(await res.arrayBuffer()));
    }
    const wav = joinWav(wavs);
    if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "TTS returned invalid audio" });
    }
    return Uint8Array.from(wav).buffer;
}

// ── Viterbox (Vietnamese + code-switching) ──────────────────────────────────
async function callViterbox(
    text: string,
    voiceKey: string,
    params: { temperature: number; topP: number; repetitionPenalty: number },
): Promise<ArrayBuffer> {
    const fastTts = process.env.FAST_TTS_API_URL?.replace(/\/$/, "");
    if (fastTts) {
        try {
            return await synthesizeWithPiper(fastTts, text, "vi");
        } catch {
            // Fall back to public cloud endpoint when LAN host is unreachable.
        }
    }
    const res = await fetch(`${env.VITERBOX_API_URL}/generate`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": env.CHATTERBOX_API_KEY, // shared API key
        },
        body: JSON.stringify({
            prompt: text,
            voice_key: voiceKey,
            // "vi" instructs Viterbox to treat text as Vietnamese-primary.
            // English words are handled via code-switching.
            language: "vi",
            exaggeration: 0.5,
            cfg_weight: 0.5,
            temperature: Math.min(params.temperature, 1.0),
            top_p: Math.min(params.topP, 1.0),
            repetition_penalty: params.repetitionPenalty,
            sentence_pause_ms: 500,
            crossfade_ms: 50,
        }),
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Viterbox error ${res.status}: ${detail}`,
        });
    }

    return res.arrayBuffer();
}

