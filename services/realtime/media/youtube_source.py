"""Fetch only public YouTube audio; no cookies, proxy bypass or arbitrary user URL."""
import json
import array
import math
import re
import subprocess
import sys
from urllib.parse import urlparse


def resolve_audio(video_id):
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
        raise ValueError('Invalid YouTube video ID')
    try:
        result = subprocess.run([
            sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-playlist',
            '--no-warnings', '--socket-timeout', '12', '--retries', '1',
            '-f', 'bestaudio[protocol=https]', '--dump-single-json', '--skip-download',
            f'https://www.youtube.com/watch?v={video_id}',
        ], capture_output=True, timeout=35, check=True)
        info = json.loads(result.stdout)
        url = info['url']
        parsed = urlparse(url)
        if parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith('.googlevideo.com'):
            raise ValueError('Unsupported media host')
        if info.get('is_live') or not isinstance(info.get('duration'), (int, float)):
            raise ValueError('Live source not supported')
        return url, info['duration']
    except (subprocess.SubprocessError, KeyError, ValueError) as exc:
        detail = (getattr(exc, 'stderr', b'') or b'').decode(errors='replace').lower()
        reason = 'YOUTUBE_AUTH_REQUIRED' if ('sign in' in detail or 'confirm you' in detail) else 'YOUTUBE_FORMAT_UNAVAILABLE' if 'requested format' in detail else 'YOUTUBE_SOURCE_UNAVAILABLE'
        raise RuntimeError(f'YouTube không cấp audio công khai cho máy chủ ({reason}). Tải lại hoặc thử một video công khai, không phát trực tiếp.') from exc


def pcm_rms(data):
    samples = array.array('h')
    samples.frombytes(data)
    if sys.byteorder != 'little':
        samples.byteswap()
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples)) if samples else 0


def pcm_chunks(url, start, duration, stopped, process_ref, chunk_seconds=3,
               adaptive=False, min_seconds=4.5, silence_seconds=0.35,
               silence_rms=320):
    """Yield timestamped PCM without cutting normal speech at every fixed window.

    Read-ahead dubbing uses ``adaptive`` to close a phrase at a sustained quiet
    boundary after ``min_seconds``. Continuous speech is still bounded by
    ``chunk_seconds`` so ASR/TTS can stay ahead of playback.
    """
    process = subprocess.Popen([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-rw_timeout', '15000000', '-protocol_whitelist', 'https,tls,tcp',
        '-ss', str(start), '-i', url, '-t', str(duration),
        '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1',
    ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    process_ref(process)
    offset = start
    frame_bytes = 640  # 20 ms of mono 16 kHz PCM16.
    maximum_bytes = round(16000 * 2 * chunk_seconds)
    minimum_bytes = round(16000 * 2 * min_seconds)
    quiet_bytes = round(16000 * 2 * silence_seconds)
    carry = b''
    try:
        while not stopped():
            if not adaptive:
                data = process.stdout.read(maximum_bytes)
                if not data:
                    break
            else:
                phrase = bytearray()
                quiet = 0
                speech_seen = False
                while len(phrase) < maximum_bytes and not stopped():
                    frame = carry or process.stdout.read(min(frame_bytes, maximum_bytes - len(phrase)))
                    carry = b''
                    if not frame:
                        break
                    is_quiet = len(frame) % 2 == 0 and pcm_rms(frame) <= silence_rms
                    # Do not attach a long silent lead-in to the next sentence.
                    # Keep the first voiced frame for the following phrase.
                    if not speech_seen and not is_quiet and len(phrase) >= quiet_bytes:
                        carry = frame
                        break
                    phrase.extend(frame)
                    if is_quiet:
                        quiet += len(frame)
                    else:
                        speech_seen = True
                        quiet = 0
                    if len(phrase) >= minimum_bytes and quiet >= quiet_bytes:
                        break
                data = bytes(phrase)
                if not data:
                    break
            if stopped():
                break
            seconds = len(data) / 32000
            yield offset, seconds, data
            offset += seconds
        if not stopped() and process.wait(timeout=20) != 0:
            raise RuntimeError('Không giải mã được audio YouTube. Tải lại hoặc thử một video công khai khác.')
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
        process_ref(None)
