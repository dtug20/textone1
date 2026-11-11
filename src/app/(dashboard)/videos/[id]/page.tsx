import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSignedAudioUrl } from "@/lib/r2";
import { VideoDetailView } from "@/features/videos/views/video-detail-view";

export default async function VideoPage({ params }: { params: Promise<{ id: string }> }) {
    const { userId, orgId } = await auth();
    if (!userId || !orgId) return null;
    const { id } = await params;
    const video = await prisma.translatedVideo.findFirst({ where: { id, orgId }, include: { segments: { orderBy: { sequence: "asc" } } } });
    if (!video) notFound();
    const segments = await Promise.all(video.segments.map(async (segment) => ({
        sequence: segment.sequence,
        duration: segment.duration,
        speechStart: segment.speechStart,
        speechEnd: segment.speechEnd,
        sourceStart: segment.sourceStart,
        text: segment.text,
        translatedText: segment.translation,
        video: await getSignedAudioUrl(segment.videoKey),
        audio: segment.audioKey ? await getSignedAudioUrl(segment.audioKey) : null,
    })));
    return <VideoDetailView video={video} segments={segments} />;
}
