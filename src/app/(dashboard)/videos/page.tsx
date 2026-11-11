import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { VideosView } from "@/features/videos/views/videos-view";

export default async function VideosPage() {
    const { userId, orgId } = await auth();
    if (!userId || !orgId) return null;
    const videos = await prisma.translatedVideo.findMany({
        where: { orgId },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { _count: { select: { segments: true } } },
    });
    return <VideosView videos={videos} />;
}
