import { RealtimeSetup, type RealtimeVoiceOption } from "../components/realtime-setup";

export function RealtimeView({ voices }: { voices: RealtimeVoiceOption[] }) {
    return <RealtimeSetup voices={voices} />;
}
