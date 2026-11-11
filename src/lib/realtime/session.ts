import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const claimsSchema = z.object({
    id: z.string().uuid(), orgId: z.string().min(1), userId: z.string().min(1),
    voiceId: z.string(), source: z.enum(["en", "vi"]), target: z.enum(["en", "vi"]),
    mode: z.enum(["transcribe", "dub"]), cloneVoice: z.boolean().optional(), expires: z.number().int(),
});
export type Session = z.infer<typeof claimsSchema>;
function signature(payload: string, secret: string) {
    if (secret.length < 32) throw new Error("REALTIME_SESSION_SECRET must contain at least 32 characters");
    return createHmac("sha256", secret).update(payload).digest();
}
export function issueSession(input: Omit<Session, "id" | "expires">, secret: string) {
    const claims = claimsSchema.parse({ ...input, id: randomUUID(), expires: Date.now() + 15 * 60_000 });
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return { token: `${payload}.${signature(payload, secret).toString("base64url")}`, expires: claims.expires };
}
export function verifySession(token: string, secret: string): Session {
    if (token.length > 4096) throw new Error("Invalid session");
    const parts = token.split(".");
    if (parts.length !== 2) throw new Error("Invalid session");
    const expected = signature(parts[0], secret);
    const actual = Buffer.from(parts[1], "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid session");
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString()));
    if (claims.expires <= Date.now()) throw new Error("Session expired");
    return claims;
}
