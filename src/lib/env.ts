import { z } from "zod";
import { createEnv } from "@t3-oss/env-nextjs";

export const env = createEnv({
    server: {
        DATABASE_URL: z.string().min(1),
        APP_URL: z.string().min(1),
        R2_ACCOUNT_ID: z.string().min(1),
        R2_ACCESS_KEY_ID: z.string().min(1),
        R2_SECRET_ACCESS_KEY: z.string().min(1),
        R2_BUCKET_NAME: z.string().min(1),
        CHATTERBOX_API_URL: z.url(),
        CHATTERBOX_API_KEY: z.string().min(1),
        VITERBOX_API_URL: z.url(),
        // Resident Piper voice on the LAN GPU host. Vietnamese synthesis uses it
        // when set; English keeps the Chatterbox endpoint.
        FAST_TTS_API_URL: z.url().optional(),
    },
    client: {
        NEXT_PUBLIC_R2_PUBLIC_URL: z.string().url(),
    },
    experimental__runtimeEnv: {
        NEXT_PUBLIC_R2_PUBLIC_URL: process.env.NEXT_PUBLIC_R2_PUBLIC_URL,
    },
    skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});