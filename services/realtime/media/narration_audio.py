"""Fit complete narration to the source speech span without changing pitch."""
import io
import math
import subprocess
import wave


def fit_narration(audio, target_seconds, max_rate=1.35):
    with wave.open(io.BytesIO(audio), 'rb') as wav:
        duration = wav.getnframes() / wav.getframerate()
    if not math.isfinite(target_seconds) or target_seconds <= 0:
        return audio, {'narrationRate': 1.0, 'audioSeconds': duration}
    rate = min(max_rate, max(1.0, duration / max(0.5, target_seconds)))
    if rate < 1.03:
        return audio, {'narrationRate': 1.0, 'audioSeconds': duration}
    result = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
         '-af', f'atempo={rate:.6f}', '-acodec', 'pcm_s16le', '-f', 'wav', 'pipe:1'],
        input=audio, capture_output=True, timeout=10, check=True,
    )
    # FFmpeg's nonseekable WAV declares an unbounded size; repair the header for
    # consumers that calculate duration from the frame count.
    with wave.open(io.BytesIO(result.stdout), 'rb') as wav:
        params = wav.getparams()
        frames = wav.readframes(wav.getnframes())
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setparams(params._replace(nframes=0)); wav.writeframes(frames)
    seconds = len(frames) / (params.framerate * params.nchannels * params.sampwidth)
    return output.getvalue(), {'narrationRate': round(rate, 3), 'audioSeconds': round(seconds, 3)}
