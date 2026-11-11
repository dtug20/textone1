"""Resident, bounded Piper HTTP service for live Vietnamese and English narration with real-time speaker voice cloning."""
import base64
import io
import os
import threading
import time
import wave
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from piper import PiperVoice, SynthesisConfig
from pydantic import BaseModel, Field


MODEL = os.environ.get('PIPER_MODEL', '/voices/vi_VN-vais1000-medium.onnx')
EN_MODEL = os.environ.get('PIPER_EN_MODEL', '/voices/en_US-lessac-medium.onnx')
EN_MALE_MODEL = os.environ.get('PIPER_EN_MALE_MODEL', '/voices/en_US-ryan-medium.onnx')

voices = {'vi': PiperVoice.load(MODEL)}
if os.path.exists(EN_MODEL):
    voices['en'] = PiperVoice.load(EN_MODEL)
if os.path.exists(EN_MALE_MODEL):
    voices['en_male'] = PiperVoice.load(EN_MALE_MODEL)

BASE_VOICE_F0 = {
    'vi': 215.0,
    'en': 195.0,
    'en_male': 118.0,
}

lock = threading.Lock()
api = FastAPI(title='TexTone fast TTS', docs_url=None, redoc_url=None)
api.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
    expose_headers=['X-Synthesis-Ms', 'X-Cloned-Voice'],
)


def analyze_speaker_wav(wav_bytes: bytes) -> dict:
    """Estimate speaker fundamental frequency (F0), spectral centroid, and vocal register from WAV bytes."""
    try:
        with wave.open(io.BytesIO(wav_bytes), 'rb') as reader:
            sr = reader.getframerate()
            channels = reader.getnchannels()
            sampwidth = reader.getsampwidth()
            raw = reader.readframes(reader.getnframes())
    except Exception as exc:
        raise ValueError(f'Invalid WAV audio: {exc}') from exc

    if sampwidth != 2 or sr < 8000 or len(raw) < 640:
        return {'f0_hz': None, 'centroid_hz': None, 'gender': None, 'voiced_frames': 0}

    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    pcm = pcm - float(np.mean(pcm))

    frame_len = max(128, int(sr * 0.032))
    hop = max(64, int(sr * 0.016))
    min_lag = max(1, int(sr / 310.0))
    max_lag = max(min_lag + 2, int(sr / 75.0))
    if len(pcm) < frame_len + max_lag:
        return {'f0_hz': None, 'centroid_hz': None, 'gender': None, 'voiced_frames': 0}

    f0s: list[float] = []
    centroids: list[float] = []
    win = np.hanning(frame_len).astype(np.float32)
    freqs = np.fft.rfftfreq(frame_len, d=1.0 / sr)
    band_mask = (freqs >= 80.0) & (freqs <= 4000.0)

    for start in range(0, len(pcm) - frame_len, hop):
        frame = pcm[start:start + frame_len]
        rms = float(np.sqrt(np.mean(frame * frame)))
        if rms < 0.014:
            continue
        zcr = float(np.mean(np.abs(np.diff(np.signbit(frame)))))
        if zcr > 0.28:
            continue
        corr = np.correlate(frame, frame, mode='full')[frame_len - 1:]
        if corr[0] <= 1e-6:
            continue
        corr = corr / corr[0]
        segment = corr[min_lag:max_lag + 1]
        if len(segment) == 0:
            continue
        peak_idx = int(np.argmax(segment))
        if float(segment[peak_idx]) < 0.40:
            continue
        lag = min_lag + peak_idx
        f0 = float(sr) / float(lag)
        if 78.0 <= f0 <= 305.0:
            f0s.append(f0)
            mag = np.abs(np.fft.rfft(frame * win))
            band_energy = float(np.sum(mag[band_mask]))
            if band_energy > 1e-6:
                centroids.append(float(np.sum(freqs[band_mask] * mag[band_mask]) / band_energy))

    if not f0s:
        return {'f0_hz': None, 'centroid_hz': None, 'gender': None, 'voiced_frames': 0}

    median_f0 = round(float(np.median(f0s)), 1)
    median_centroid = round(float(np.median(centroids)), 1) if centroids else 1200.0
    gender: Literal['male', 'female'] = 'male' if median_f0 < 165.0 else 'female'
    return {
        'f0_hz': median_f0,
        'centroid_hz': median_centroid,
        'gender': gender,
        'voiced_frames': len(f0s),
    }


def wsola_stretch(x: np.ndarray, rate: float, sr: int = 22050) -> np.ndarray:
    """Waveform similarity overlap-add time-scale modification (rate > 1 shortens, rate < 1 lengthens)."""
    if abs(rate - 1.0) < 0.025 or len(x) < 1024:
        return x
    win_len = int(sr * 0.028)
    if win_len % 2 == 1:
        win_len += 1
    hop_s = win_len // 2
    hop_a = max(1, int(round(hop_s * rate)))
    tol = max(4, int(sr * 0.006))
    win = np.hanning(win_len).astype(np.float32)
    out_len = int(len(x) / rate) + win_len
    out = np.zeros(out_len, dtype=np.float32)
    norm = np.zeros(out_len, dtype=np.float32)
    a_pos = 0
    s_pos = 0
    while a_pos + win_len + tol < len(x) and s_pos + win_len < out_len:
        if s_pos > 0 and a_pos > tol:
            target = out[s_pos:s_pos + hop_s:2]
            if float(np.dot(target, target)) > 1e-6:
                s0 = max(0, a_pos - tol)
                s1 = min(len(x) - win_len, a_pos + tol)
                region = x[s0:s1 + hop_s:2]
                if len(region) >= len(target) and len(target) > 4:
                    corr = np.correlate(region, target, mode='valid')
                    a_idx = min(len(x) - win_len, s0 + int(np.argmax(corr)) * 2)
                else:
                    a_idx = a_pos
            else:
                a_idx = a_pos
        else:
            a_idx = a_pos
        out[s_pos:s_pos + win_len] += x[a_idx:a_idx + win_len] * win
        norm[s_pos:s_pos + win_len] += win
        s_pos += hop_s
        a_pos += hop_a
    valid = norm > 1e-3
    out[valid] /= norm[valid]
    return out[:s_pos + hop_s]


def adapt_wav_to_speaker(wav_bytes: bytes, base_f0: float, target_f0: float, residual_time_rate: float = 1.0) -> bytes:
    """Shift pitch and vocal tract timbre of synthesized WAV to match the video speaker's F0."""
    pitch_ratio = float(np.clip(target_f0 / base_f0, 0.58, 1.32))
    if abs(pitch_ratio - 1.0) < 0.03 and abs(residual_time_rate - 1.0) < 0.03:
        return wav_bytes

    with wave.open(io.BytesIO(wav_bytes), 'rb') as reader:
        sr = reader.getframerate()
        raw = reader.readframes(reader.getnframes())
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if len(pcm) < 512:
        return wav_bytes

    # Pre-compensate duration with WSOLA so resampling by pitch_ratio keeps the target speaking tempo.
    stretch_rate = residual_time_rate / pitch_ratio
    stretched = wsola_stretch(pcm, stretch_rate, sr)
    idx = np.arange(0.0, float(len(stretched)), pitch_ratio, dtype=np.float32)
    shifted = np.interp(idx, np.arange(len(stretched), dtype=np.float32), stretched).astype(np.float32)

    # Restore upper-formant clarity when lowering pitch so articulation stays crisp and natural.
    if pitch_ratio < 0.90 and len(shifted) > 2:
        alpha = float(np.clip((1.0 - pitch_ratio) * 0.42, 0.0, 0.24))
        high = np.empty_like(shifted)
        high[0] = 0.0
        high[1:] = shifted[1:] - shifted[:-1]
        shifted = shifted + alpha * high

    peak = float(np.max(np.abs(shifted))) if len(shifted) else 0.0
    if peak > 0.96:
        shifted = shifted * (0.96 / peak)

    pcm_int16 = np.clip(np.round(shifted * 32767.0), -32768, 32767).astype(np.int16).tobytes()
    out_buf = io.BytesIO()
    with wave.open(out_buf, 'wb') as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sr)
        writer.writeframes(pcm_int16)
    return out_buf.getvalue()


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    length_scale: float = Field(default=0.76, ge=0.5, le=1.5)
    language: Literal['vi', 'en'] = 'vi'
    clone_voice: bool = False
    speaker_f0: float | None = Field(default=None, ge=75.0, le=320.0)
    speaker_gender: Literal['male', 'female'] | None = None
    reference_audio: str | None = Field(default=None, max_length=2_000_000)


@api.get('/health')
def health():
    return {
        'ready': True,
        'engine': 'piper',
        'voice': 'vi_VN-vais1000-medium',
        'languages': sorted(k for k in voices.keys() if k in ('vi', 'en')),
        'voiceCloning': True,
    }


@api.get('/info')
def info():
    return health()


@api.post('/analyze-voice')
async def analyze_voice(request: Request):
    content_type = (request.headers.get('content-type') or '').lower()
    if 'application/json' in content_type:
        payload = await request.json()
        encoded = payload.get('audio') or ''
        if not encoded:
            raise HTTPException(status_code=400, detail='Missing audio field')
        wav_bytes = base64.b64decode(encoded)
    else:
        wav_bytes = await request.body()
    if not wav_bytes:
        raise HTTPException(status_code=400, detail='Empty audio payload')
    try:
        return analyze_speaker_wav(wav_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@api.post('/synthesize')
def synthesize(request: SynthesisRequest):
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail='Text is empty')

    target_f0 = request.speaker_f0
    target_gender = request.speaker_gender
    if request.clone_voice and target_f0 is None and request.reference_audio:
        try:
            profile = analyze_speaker_wav(base64.b64decode(request.reference_audio))
            target_f0 = profile.get('f0_hz')
            target_gender = target_gender or profile.get('gender')
        except Exception:
            pass
    if request.clone_voice and target_f0 is None:
        if target_gender == 'male':
            target_f0 = 132.0
        elif target_gender == 'female':
            target_f0 = 205.0
        else:
            target_f0 = 142.0
    if request.clone_voice and target_gender is None and target_f0 is not None:
        target_gender = 'male' if target_f0 < 165.0 else 'female'

    voice_key = request.language
    if request.clone_voice and request.language == 'en' and target_gender == 'male' and 'en_male' in voices:
        voice_key = 'en_male'

    selected = voices.get(voice_key) or voices.get(request.language)
    if selected is None:
        raise HTTPException(status_code=503, detail=f'Language {request.language} is unavailable')

    started = time.monotonic()
    base_f0 = BASE_VOICE_F0.get(voice_key, 215.0)
    syn_length_scale = request.length_scale
    residual_time_rate = 1.0
    if request.clone_voice and target_f0 is not None:
        pitch_ratio = float(np.clip(target_f0 / base_f0, 0.58, 1.32))
        # Let VITS handle part of the duration compensation natively so WSOLA stays minimal and crisp.
        neural_factor = float(np.clip(pitch_ratio, 0.76, 1.15))
        syn_length_scale = float(np.clip(request.length_scale * neural_factor, 0.52, 1.45))
        Actual_factor = syn_length_scale / request.length_scale
        residual_time_rate = Actual_factor

    output = io.BytesIO()
    with lock, wave.open(output, 'wb') as writer:
        selected.synthesize_wav(text, writer, syn_config=SynthesisConfig(length_scale=syn_length_scale))
    wav_data = output.getvalue()

    headers = {
        'Cache-Control': 'no-store',
    }
    if request.clone_voice and target_f0 is not None:
        wav_data = adapt_wav_to_speaker(wav_data, base_f0=base_f0, target_f0=target_f0, residual_time_rate=residual_time_rate)
        headers['X-Cloned-Voice'] = f"{target_gender or 'auto'}:{round(target_f0)}Hz"

    headers['X-Synthesis-Ms'] = str(round((time.monotonic() - started) * 1000))
    return Response(wav_data, media_type='audio/wav', headers=headers)
