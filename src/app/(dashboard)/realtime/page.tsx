import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { RealtimeView } from "@/features/realtime/views/realtime-view";

export default async function RealtimePage() {
    const { orgId } = await auth();
    if (!orgId) return null;
    const voices = await prisma.voice.findMany({
        where: { r2ObjectKey: { not: null }, OR: [{ variant: "SYSTEM" }, { variant: "CUSTOM", orgId }] },
        select: { id: true, name: true, language: true },
        orderBy: { name: "asc" },
    });
    return <RealtimeView voices={voices} />;
}
