"""QThread pipeline gateway: Modal CPU workers orchestrate existing GPU models.
Deploy: modal deploy services/realtime/gateway/realtime_pipeline.py
"""
import modal

VOICE_COMMIT = 'c10ece1aade47bb51c153c893d14e5bf8e5b7117'
VOICE_BASE = f'https://huggingface.co/rhasspy/piper-voices/resolve/{VOICE_COMMIT}'

image = (modal.Image.debian_slim(python_version='3.11')
         .apt_install('ffmpeg', 'libglib2.0-0', 'curl', 'ca-certificates')
         .pip_install('fastapi[standard]==0.124.4', 'httpx==0.28.1', 'PySide6-Essentials==6.8.3', 'yt-dlp==2026.8.19', 'piper-tts==1.8.0')
         .run_commands(
             f'mkdir -p /voices'
             f' && curl -fL --retry 3 -o /voices/vi_VN-vais1000-medium.onnx "{VOICE_BASE}/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx"'
             f' && curl -fsSL --retry 3 -o /voices/vi_VN-vais1000-medium.onnx.json "{VOICE_BASE}/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx.json"'
             f' && curl -fsSL --retry 3 -o /voices/MODEL_CARD "{VOICE_BASE}/vi/vi_VN/vais1000/medium/MODEL_CARD"'
             f' && curl -fL --retry 3 -o /voices/en_US-lessac-medium.onnx "{VOICE_BASE}/en/en_US/lessac/medium/en_US-lessac-medium.onnx"'
             f' && curl -fsSL --retry 3 -o /voices/en_US-lessac-medium.onnx.json "{VOICE_BASE}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"'
             f' && curl -fsSL --retry 3 -o /voices/MODEL_CARD_EN "{VOICE_BASE}/en/en_US/lessac/medium/MODEL_CARD"'
             f' && curl -fL --retry 3 -o /voices/en_US-ryan-medium.onnx "{VOICE_BASE}/en/en_US/ryan/medium/en_US-ryan-medium.onnx"'
             f' && curl -fsSL --retry 3 -o /voices/en_US-ryan-medium.onnx.json "{VOICE_BASE}/en/en_US/ryan/medium/en_US-ryan-medium.onnx.json"'
         )
         .add_local_file('services/realtime/gateway/pipeline_core.py', '/root/pipeline_core.py')
         .add_local_file('services/realtime/media/youtube_source.py', '/root/youtube_source.py')
         .add_local_file('services/realtime/media/narration_audio.py', '/root/narration_audio.py')
         .add_local_file('services/realtime/speech/speech_context.py', '/root/speech_context.py')
         .add_local_file('services/realtime/media/caption_timeline.py', '/root/caption_timeline.py')
         .add_local_file('services/realtime/tts/fast_tts.py', '/root/fast_tts.py'))
app = modal.App('textone-pipeline', image=image)


@app.function(cpu=2, memory=2048, timeout=1800, scaledown_window=300,
              secrets=[modal.Secret.from_name('chatterbox-api-key')],
              env={'PIPELINE_APP_URL': 'https://textone.id.vn',
                   'REALTIME_API_URL': 'https://dtug20--resonance-realtime-speechservice-serve.modal.run',
                   'FAST_TTS_API_URL': 'https://dtug20--textone-pipeline-serve.modal.run',
                   'VITERBOX_API_URL': 'https://dtug20--viterbox-tts-viterboxservice-serve.modal.run',
                   'CHATTERBOX_API_URL': 'https://dtug20--chatterbox-tts-chatterbox-serve.modal.run'})
@modal.concurrent(max_inputs=8)
@modal.asgi_app()
def serve():
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    import anyio
    import array
    import base64
    import io
    import json
    import math
    import os
    import queue
    import struct
    import threading
    import time
    import traceback
    import wave
    import httpx
    from fastapi import FastAPI, Request, WebSocket
    from fastapi.middleware.cors import CORSMiddleware
    from PySide6.QtCore import QThread
    from pipeline_core import Pipeline
    from narration_audio import fit_narration
    from youtube_source import resolve_audio, pcm_chunks
    from caption_timeline import normalize_cues, caption_items

    api = FastAPI()
    api.add_middleware(
        CORSMiddleware,
        allow_origins=['*'],
        allow_methods=['*'],
        allow_headers=['*'],
    )
    api_url = os.environ['PIPELINE_APP_URL'].rstrip('/') + '/api/realtime/pipeline'
    key = os.environ['CHATTERBOX_API_KEY']
    # Piper values below 1.0 speak faster. Keep this bounded so deployment
    # tuning cannot make Vietnamese narration unintelligible.
    fast_tts_length_scale = min(1.0, max(0.65, float(os.environ.get('FAST_TTS_LENGTH_SCALE', '0.76'))))
    # Caption files expose future timestamps, so prepare well ahead of the
    # playhead. Full-sentence translation keeps its context without waiting for
    # the speaker to finish in real time.
    caption_read_ahead = min(180.0, max(30.0, float(os.environ.get('CAPTION_READ_AHEAD_SECONDS', '60'))))

    @api.get('/health')
    def health():
        return {'ready': True, 'protocol': 2, 'workers': 'QThread', 'contextAware': True}

    _fast_tts_mod = [None]
    _fast_tts_lock = threading.Lock()

    def _fast_tts():
        if _fast_tts_mod[0] is None:
            with _fast_tts_lock:
                if _fast_tts_mod[0] is None:
                    import fast_tts as _mod
                    _fast_tts_mod[0] = _mod
        return _fast_tts_mod[0]

    @api.post('/analyze-voice')
    async def analyze_voice_endpoint(request: Request):
        mod = await asyncio.to_thread(_fast_tts)
        return await mod.analyze_voice(request)

    @api.post('/synthesize')
    def synthesize_endpoint(payload: dict):
        mod = _fast_tts()
        return mod.synthesize(mod.SynthesisRequest(**payload))

    @api.websocket('/stream')
    async def stream(ws: WebSocket):
        await ws.accept()
        pipeline = None
        source_thread = None
        lease = None
        closed = threading.Event()
        output = queue.Queue(maxsize=8)
        auth_lock = threading.Lock()
        process_lock = threading.Lock()
        process = [None]
        source_commands = queue.Queue(maxsize=1)
        config = {}
        clients = []
        tasks = []
        token = ''
        budget = 0
        budget_lock = threading.Lock()
        refill_pool = ThreadPoolExecutor(max_workers=1)
        refill = None
        playhead = 0.0
        source_eof = False
        caption_lock = threading.Lock()
        caption_ready = threading.Event()
        caption_cues = []
        phrase_lock = threading.Lock()
        phrase = {'generation': 0, 'audio': b'', 'start': None, 'context': ''}
        speaker_lock = threading.Lock()
        speaker_profile = {'f0_samples': [], 'f0_hz': None, 'gender': None, 'sampling': False}

        def estimate_pcm_f0(pcm_bytes, sample_rate=16000):
            clipped = pcm_bytes[:min(len(pcm_bytes), sample_rate * 2 * 4)]
            if len(clipped) < 1600 or sample_rate < 8000:
                return None
            samples = array.array('h')
            samples.frombytes(clipped[:len(clipped) - (len(clipped) % 2)])
            step = max(1, round(sample_rate / 4000))
            sr = sample_rate / step
            dec = samples[::step]
            n = len(dec)
            frame_len = int(sr * 0.032)
            hop = max(1, int(sr * 0.032))
            min_lag = max(1, int(sr / 305.0))
            max_lag = max(min_lag + 2, int(sr / 78.0))
            if n < frame_len + max_lag:
                return None
            f0s = []
            for start in range(0, n - frame_len, hop):
                frame = dec[start:start + frame_len]
                mean = sum(frame) / frame_len
                centered = [x - mean for x in frame]
                energy = sum(x * x for x in centered)
                rms = math.sqrt(energy / frame_len)
                if rms < 350.0 or energy <= 1.0:
                    continue
                zcr = sum(1 for i in range(1, frame_len) if (centered[i] >= 0) != (centered[i - 1] >= 0)) / frame_len
                if zcr > 0.28:
                    continue
                best_lag = 0
                best_corr = 0.0
                for lag in range(min_lag, min(max_lag + 1, frame_len)):
                    c = sum(centered[i] * centered[i + lag] for i in range(frame_len - lag))
                    if c > best_corr:
                        best_corr = c
                        best_lag = lag
                if best_lag > 0 and (best_corr / energy) >= 0.40:
                    f0 = sr / best_lag
                    if 78.0 <= f0 <= 305.0:
                        f0s.append(f0)
            if not f0s:
                return None
            f0s.sort()
            return round(f0s[len(f0s) // 2], 1)

        def update_speaker_pcm(pcm_bytes, sample_rate=16000):
            f0 = estimate_pcm_f0(pcm_bytes, sample_rate)
            if f0 is None:
                return
            with speaker_lock:
                samples_list = speaker_profile['f0_samples']
                samples_list.append(f0)
                if len(samples_list) > 12:
                    del samples_list[:-12]
                ordered = sorted(samples_list)
                median_f0 = round(ordered[len(ordered) // 2], 1)
                speaker_profile['f0_hz'] = median_f0
                speaker_profile['gender'] = 'male' if median_f0 < 165.0 else 'female'

        def update_speaker_wav(wav_bytes):
            try:
                with wave.open(io.BytesIO(wav_bytes), 'rb') as handle:
                    sr = handle.getframerate()
                    ch = handle.getnchannels()
                    sw = handle.getsampwidth()
                    raw_frames = handle.readframes(handle.getnframes())
                if sw != 2 or sr < 8000:
                    return
                if ch > 1:
                    raw_samples = array.array('h')
                    raw_samples.frombytes(raw_frames[:len(raw_frames) - (len(raw_frames) % (2 * ch))])
                    mono = array.array('h', (raw_samples[i] for i in range(0, len(raw_samples), ch)))
                    raw_frames = mono.tobytes()
                update_speaker_pcm(raw_frames, sr)
            except Exception:
                pass

        def sample_youtube_speaker(start_hint=0.0):
            if not config.get('cloneVoice') or not config.get('videoId'):
                return
            with speaker_lock:
                if speaker_profile['f0_hz'] is not None or speaker_profile['sampling']:
                    return
                speaker_profile['sampling'] = True

            def _worker():
                try:
                    url, dur = resolve_audio(config['videoId'])
                    sample_pos = min(max(0.0, float(start_hint)), max(0.0, dur - 5.0))
                    for _, _, pcm in pcm_chunks(url, sample_pos, min(5.0, max(1.0, dur - sample_pos)), lambda: closed.is_set(), lambda _: None, chunk_seconds=4, adaptive=False):
                        if closed.is_set():
                            break
                        update_speaker_pcm(pcm, 16000)
                        with speaker_lock:
                            if speaker_profile['f0_hz'] is not None:
                                break
                except Exception:
                    pass
                finally:
                    with speaker_lock:
                        speaker_profile['sampling'] = False

            threading.Thread(target=_worker, daemon=True).start()

        def reset_phrase(generation):
            with phrase_lock:
                phrase.update(generation=generation, audio=b'', start=None, context='')

        def emit(event):
            while not closed.is_set():
                try:
                    output.put(event, timeout=0.1)
                    return
                except queue.Full:
                    continue

        def authorization(action, reserve=False):
            nonlocal lease, budget
            with auth_lock:
                payload = {'action': action, 'reserve': reserve}
                if lease is not None:
                    payload['lease'] = lease
                response = httpx.post(api_url, headers={'Authorization': f'Bearer {token}', 'x-api-key': key},
                                      json=payload, timeout=15)
                if response.status_code != 200:
                    errors = {401: 'Phiên đã hết hạn hoặc bị thay thế. Tạo mã phiên mới.',
                              403: 'Khóa dịch vụ pipeline không khớp cấu hình máy chủ.',
                              409: 'Phiên đang bận hoặc đã hết hạn mức. Dừng phiên cũ hoặc tạo mã mới.'}
                    raise RuntimeError(errors.get(response.status_code, f'Lỗi xác thực pipeline (HTTP {response.status_code}).'))
                result = response.json()
                lease = result['lease']
                with budget_lock:
                    budget += result['budget']
                return result

        def reserve_chunk():
            nonlocal budget, refill
            if refill is not None and refill.done():
                refill.result()  # Surface quota/revocation failures, never ignore them.
                refill = None
            with budget_lock:
                empty = budget <= 0
            if empty:
                if refill is not None:
                    refill.result(); refill = None
                else:
                    authorization('renew', True)
            with budget_lock:
                if budget <= 0:
                    raise RuntimeError('Hết hạn mức pipeline.')
                budget -= 1
                replenish = budget <= 2
            if replenish and refill is None:
                refill = refill_pool.submit(authorization, 'renew', True)

        def wav(pcm):
            output_wav = io.BytesIO()
            with wave.open(output_wav, 'wb') as handle:
                handle.setnchannels(1); handle.setsampwidth(2); handle.setframerate(16000)
                handle.writeframes(pcm)
            return output_wav.getvalue()

        def recognize(item):
            reserve_chunk()
            started = time.monotonic()
            if item.pop('needsTranslation', False):
                try:
                    response = clients[0].post(os.environ['REALTIME_API_URL'].rstrip('/') + '/translate',
                                               params={'source': config['source'], 'target': config['target']},
                                               json={'text': item['text']})
                except httpx.HTTPError:
                    response = None
                if response is not None and response.status_code == 200:
                    result = response.json()
                    item['translatedText'] = result.get('translatedText') or item['translatedText']
                    item['timings'] = {'sttMs': 0, **(result.get('modelTimings') or {}), 'translationSource': 'GPU full sentence'}
                else:
                    # A translator miss must not close the session. Keep a real
                    # subtitle translation; skip speech only when none exists.
                    if item['translatedText'].casefold() == item['text'].casefold() and config['source'] != config['target']:
                        item['translatedText'] = ''
                    item['timings'] = {'sttMs': 0, 'queueMs': 0, 'asrMs': 0,
                                       'translationMs': 0, 'translationSource': 'YouTube fallback'}
                emit({**item, 'type': 'transcript', 'partial': False, 'started': None})
                return item
            pcm = item.pop('pcm')
            leading_overlap = min(float(item.pop('leadingOverlap', 0)), len(pcm) / 32000)
            unique_pcm = pcm[round(leading_overlap * 32000):]
            with phrase_lock:
                if item['generation'] != phrase['generation']:
                    return None
                phrase_pcm = phrase['audio'] + unique_pcm
                phrase_start = phrase['start'] if phrase['start'] is not None else item['sourceStart'] + leading_overlap
                phrase_duration = len(phrase_pcm) / 32000
                commit = item.get('boundary', 'pause') == 'pause' or phrase_duration >= 3.2
                prompt = phrase['context'][-800:]
            if config.get('cloneVoice') and phrase_duration >= 0.8:
                update_speaker_pcm(phrase_pcm, 16000)
            response = clients[0].post(os.environ['REALTIME_API_URL'].rstrip('/') + '/process',
                                      params={'source': config['source'],
                                              'target': config['target'] if commit and config['mode'] == 'dub' else config['source'],
                                              'prompt': prompt},
                                      content=wav(phrase_pcm), headers={'Content-Type': 'audio/wav'})
            if response.status_code != 200:
                raise RuntimeError('GPU nhận dạng chưa phản hồi. Dừng và thử lại.')
            result = response.json()
            item.update({k: result.get(k) for k in ('text', 'translatedText', 'speechStart', 'speechEnd')})
            item['timings'] = {'sttMs': round((time.monotonic() - started) * 1000), **(result.get('modelTimings') or {})}
            with phrase_lock:
                if item['generation'] != phrase['generation'] or item['generation'] != pipeline.generation:
                    return None
                source_text = (result.get('sourceText') or result.get('text') or '').strip()
                item['text'] = source_text
                if not commit:
                    phrase['audio'] = phrase_pcm
                    phrase['start'] = phrase_start
                    item['sourceStart'] = phrase_start
                    item['duration'] = phrase_duration
                    item['translatedText'] = ''
                    emit({**item, 'type': 'transcript', 'partial': True, 'started': None})
                    return None
                phrase['audio'] = b''
                phrase['start'] = None
                if source_text:
                    phrase['context'] = ' '.join(part for part in (phrase['context'], source_text) if part)[-800:]
                item['sourceStart'] = phrase_start
                item['duration'] = phrase_duration
                speech_start = item.get('speechStart')
                speech_end = item.get('speechEnd')
                if source_text and not (isinstance(speech_start, (int, float)) and isinstance(speech_end, (int, float)) and 0 <= speech_start < speech_end <= phrase_duration):
                    speech_start, speech_end = 0, phrase_duration
                item['speechStart'] = speech_start
                item['speechEnd'] = speech_end
            emit({**item, 'type': 'transcript', 'partial': False, 'started': None})
            return item

        def synthesize(item):
            started = time.monotonic()
            audio = None
            if config['mode'] == 'dub' and (item.get('translatedText') or '').strip():
                vi = config['target'] == 'vi'
                fast_tts = os.environ.get('FAST_TTS_API_URL') if config['target'] in ('vi', 'en') else None
                endpoint = (fast_tts or os.environ['VITERBOX_API_URL' if vi else 'CHATTERBOX_API_URL']).rstrip('/')
                if fast_tts:
                    body = {'text': item['translatedText'], 'length_scale': fast_tts_length_scale if vi else 0.92}
                    if not vi:
                        body['language'] = config['target']
                    if config.get('cloneVoice'):
                        with speaker_lock:
                            f0_hz = speaker_profile['f0_hz']
                            gender = speaker_profile['gender']
                        body['clone_voice'] = True
                        if f0_hz is not None:
                            body['speaker_f0'] = f0_hz
                            body['speaker_gender'] = gender
                            item['timings']['clonedVoice'] = f"{'nam' if gender == 'male' else 'nữ'} · {round(f0_hz)} Hz"
                        else:
                            item['timings']['clonedVoice'] = 'đang lấy mẫu giọng'
                    path = '/synthesize'
                else:
                    body = {'prompt': item['translatedText'], 'voice_key': config['voice']}
                    path = '/generate'
                if vi and not fast_tts:
                    body.update(language='vi', sentence_pause_ms=80, crossfade_ms=20, split_sentences=False)
                response = clients[1].post(endpoint + path, json=body)
                data = response.content
                if response.status_code != 200 or len(data) < 44 or data[:4] != b'RIFF':
                    raise RuntimeError('GPU tạo giọng chưa phản hồi. Dừng và thử lại.')
                # Read-ahead already fits media playback itself. Live capture needs
                # pitch-preserving time compression before it reaches Web Audio.
                if config['input'] in ('tab', 'captions'):
                    span = item.get('speechEnd')
                    start = item.get('speechStart')
                    target = span - start if isinstance(span, (int, float)) and isinstance(start, (int, float)) and span > start else item['duration']
                    adjusted = time.monotonic()
                    data, pacing = fit_narration(data, target, max_rate=1.8 if config['input'] == 'captions' else 1.5)
                    item['timings'].update(pacing)
                    item['timings']['pacingMs'] = round((time.monotonic() - adjusted) * 1000)
                audio = base64.b64encode(data).decode()
            item['timings']['ttsMs'] = round((time.monotonic() - started) * 1000)
            item['timings']['totalMs'] = round((time.monotonic() - item.pop('started')) * 1000)
            return {**item, 'type': 'audio', 'audio': audio}

        def set_process(value):
            with process_lock:
                process[0] = value
                if value and closed.is_set():
                    value.kill()

        def kill_decoder():
            with process_lock:
                if process[0] and process[0].poll() is None:
                    process[0].kill()

        class SourceThread(QThread):
            def run(self):
                nonlocal source_eof
                try:
                    if config['input'] == 'youtube':
                        url, duration = resolve_audio(config['videoId'])
                    else:
                        url, duration = None, config['duration']
                    emit({'type': 'source', 'duration': duration})
                    while not closed.is_set() and not pipeline.closed.is_set():
                        try:
                            command = source_commands.get(timeout=0.1)
                        except queue.Empty:
                            continue
                        generation = command['generation']
                        position = command['position']
                        source_eof = False
                        if position >= duration:
                            emit({'type': 'eof', 'generation': generation}); source_eof = True
                            continue
                        stopped = lambda: closed.is_set() or pipeline.closed.is_set() or pipeline.generation != generation
                        try:
                            if config['input'] == 'captions':
                                while not caption_ready.wait(0.1):
                                    if stopped(): break
                                if stopped(): continue
                                with caption_lock:
                                    cues = list(caption_cues)
                                first_spoken = next((c['start'] for c in cues if (c.get('text') or '').strip()), position)
                                sample_youtube_speaker(first_spoken)
                                for item in caption_items(cues, position, duration, generation):
                                    while item['sourceStart'] > playhead + caption_read_ahead and not stopped():
                                        time.sleep(0.1)
                                    if stopped(): break
                                    item['started'] = time.monotonic()
                                    if item.pop('silent'):
                                        emit({**item, 'type': 'audio', 'audio': None,
                                              'timings': {'sttMs': 0, 'queueMs': 0, 'asrMs': 0,
                                                          'translationMs': 0, 'ttsMs': 0, 'totalMs': 0}})
                                    else:
                                        item['timings'] = {'sttMs': 0, 'queueMs': 0, 'asrMs': 0, 'translationMs': 0}
                                        if item.get('needsTranslation'):
                                            pipeline.put(pipeline.audio, item)
                                        else:
                                            reserve_chunk()
                                            emit({**item, 'type': 'transcript', 'partial': False, 'started': None})
                                            pipeline.put(pipeline.text, item)
                                if not stopped():
                                    source_eof = True
                                    emit({'type': 'eof', 'generation': generation})
                                continue
                            # Prefer sentence-like pauses over arbitrary packet
                            # boundaries. Fast continuous speech gets a bounded
                            # ten-second context window instead of short fragments.
                            for start, length, pcm in pcm_chunks(
                                    url, position, min(900, duration - position), stopped,
                                    set_process, chunk_seconds=10, adaptive=True):
                                while start > playhead + 24 and not stopped():
                                    time.sleep(0.1)
                                if stopped():
                                    break
                                pipeline.put(pipeline.audio, {'generation': generation, 'sequence': round(start * 1000), 'sourceStart': start, 'duration': length, 'pcm': pcm, 'started': time.monotonic()})
                            if not stopped():
                                source_eof = True
                                emit({'type': 'eof', 'generation': generation})
                        except Exception:
                            if not stopped():
                                raise
                except Exception as exc:
                    emit({'type': 'error', 'error': str(exc), 'generation': pipeline.generation})

        async def sender():
            while not closed.is_set():
                try:
                    item = await asyncio.to_thread(output.get, True, 0.25)
                except queue.Empty:
                    continue
                if item.get('generation', pipeline.generation) != pipeline.generation:
                    continue
                await ws.send_json(item)
                if item['type'] == 'error':
                    raise RuntimeError(item['error'])

        async def heartbeat():
            while True:
                await asyncio.sleep(25)
                if time.time() * 1000 >= config['expires']:
                    raise RuntimeError('Phiên đã hết hạn.')
                await asyncio.to_thread(authorization, 'renew')

        async def receiver():
            nonlocal playhead
            last_sequence = -1
            overlap_next = False
            while True:
                packet = await ws.receive()
                if packet['type'] == 'websocket.disconnect':
                    return
                if packet.get('bytes') is not None:
                    data = packet['bytes']
                    header_size = 20 if config.get('protocol') == 2 else 16
                    if config['input'] != 'tab' or len(data) < header_size + 2 or len(data) > 192020 or (len(data) - header_size) % 2:
                        raise RuntimeError('Invalid audio frame')
                    generation, sequence, position = struct.unpack('<IId', data[:16])
                    boundary = 'pause'
                    if header_size == 20:
                        if data[16] not in (0, 1) or any(data[17:20]):
                            raise RuntimeError('Invalid audio boundary')
                        boundary = 'pause' if data[16] == 1 else 'window'
                    leading_overlap = 0.32 if header_size == 20 and overlap_next else 0
                    overlap_next = header_size == 20 and boundary == 'window'
                    if generation != pipeline.generation or sequence <= last_sequence:
                        continue
                    if not math.isfinite(position) or position < 0:
                        raise RuntimeError('Invalid position')
                    last_sequence = sequence
                    pipeline.submit({'generation': generation, 'sequence': sequence, 'sourceStart': position,
                                     'duration': (len(data) - header_size) / 32000, 'boundary': boundary,
                                     'leadingOverlap': leading_overlap,
                                     'pcm': data[header_size:], 'started': time.monotonic()})
                else:
                    raw = packet.get('text') or ''
                    max_raw = 262144 if 'voice-sample' in raw[:64] else (65536 if config.get('input') == 'captions' else 2048)
                    if len(raw) > max_raw:
                        raise RuntimeError('Message too large')
                    data = json.loads(raw)
                    if data.get('type') == 'captions':
                        if config['input'] != 'captions' or caption_ready.is_set():
                            raise RuntimeError('Unexpected captions')
                        cues = normalize_cues(data.get('cues'), config['duration'])
                        with caption_lock:
                            if len(caption_cues) + len(cues) > 2000:
                                raise RuntimeError('Quá nhiều đoạn phụ đề.')
                            caption_cues.extend(cues)
                    elif data.get('type') == 'captions-end':
                        if config['input'] != 'captions':
                            raise RuntimeError('Unexpected captions')
                        with caption_lock:
                            if not caption_cues:
                                raise RuntimeError('YouTube không trả về phụ đề dịch.')
                            caption_cues[:] = normalize_cues(sorted(caption_cues, key=lambda cue: cue['start']), config['duration'])
                        caption_ready.set()
                    elif data.get('type') == 'voice-sample':
                        encoded_sample = data.get('audio') or ''
                        if isinstance(encoded_sample, str) and 44 <= len(encoded_sample) <= 240000:
                            try:
                                update_speaker_wav(base64.b64decode(encoded_sample))
                            except Exception:
                                pass
                    elif data.get('type') == 'clone-voice':
                        config['cloneVoice'] = bool(data.get('enabled'))
                        if config['cloneVoice']:
                            sample_youtube_speaker(playhead)
                    elif data.get('type') == 'position':
                        position = float(data['position'])
                        if not math.isfinite(position) or position < 0:
                            raise RuntimeError('Invalid position')
                        playhead = position
                    elif data.get('type') == 'reset':
                        generation = data['generation']
                        position = float(data.get('position', 0))
                        if not isinstance(generation, int) or not pipeline.generation < generation < 2**32 or not math.isfinite(position) or position < 0:
                            raise RuntimeError('Invalid generation')
                        pipeline.reset(generation); reset_phrase(generation); playhead = position; last_sequence = -1; overlap_next = False
                        kill_decoder()
                        if config['input'] in ('youtube', 'captions'):
                            try: source_commands.get_nowait()
                            except queue.Empty: pass
                            source_commands.put_nowait({'generation': generation, 'position': position})

        try:
            raw = await asyncio.wait_for(ws.receive_text(), 10)
            if len(raw) > 8192:
                raise RuntimeError('Handshake too large')
            hello = json.loads(raw)
            token = hello['token']
            if not isinstance(token, str) or len(token) > 4096:
                raise RuntimeError('Invalid token')
            config = await asyncio.to_thread(authorization, 'acquire')
            config['cloneVoice'] = bool(hello.get('cloneVoice') or config.get('cloneVoice'))
            config['input'] = hello.get('input', 'tab')
            if config['input'] not in ('tab', 'youtube', 'captions'):
                raise RuntimeError('Invalid source')
            config['videoId'] = hello.get('videoId', '')
            duration = hello.get('duration')
            if config['input'] == 'captions':
                if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 24 * 3600:
                    raise RuntimeError('Invalid caption duration')
                config['duration'] = float(duration)
            protocol = hello.get('protocol', 1)
            if not isinstance(protocol, int) or protocol not in (1, 2):
                raise RuntimeError('Invalid protocol')
            config['protocol'] = protocol
            playhead = float(hello.get('position', 0))
            if not math.isfinite(playhead) or playhead < 0:
                raise RuntimeError('Invalid position')
            clients = [httpx.Client(headers={'x-api-key': key}, timeout=90) for _ in range(2)]
            # Wake GPU containers concurrently while source resolution/capture starts.
            async def warm(url):
                try:
                    async with httpx.AsyncClient() as client:
                        response = await client.get(url.rstrip('/') + '/health', headers={'x-api-key': key}, timeout=90)
                        response.raise_for_status()
                except Exception as exc:
                    raise RuntimeError('Không khởi động được GPU. Dừng và thử lại.') from exc
            # Caption mode skips Whisper but can still need full-sentence GPU
            # translation. Warm the shared speech service before sending ready.
            tasks.append(asyncio.create_task(warm(os.environ['REALTIME_API_URL'])))
            async def prime_voice():
                vi = config['target'] == 'vi'
                fast_tts = os.environ.get('FAST_TTS_API_URL') if config['target'] in ('vi', 'en') else None
                endpoint = (fast_tts or os.environ['VITERBOX_API_URL' if vi else 'CHATTERBOX_API_URL']).rstrip('/')
                if fast_tts:
                    body = {'text': 'Xin chào.' if vi else 'Hello.', 'length_scale': fast_tts_length_scale if vi else 0.92}
                    if not vi:
                        body['language'] = config['target']
                    path = '/synthesize'
                else:
                    body = {'prompt': 'Xin chào.' if vi else 'Hello.', 'voice_key': config['voice']}
                    path = '/generate'
                if vi and not fast_tts:
                    body.update(language='vi', sentence_pause_ms=80, crossfade_ms=20, split_sentences=False)
                response = await asyncio.to_thread(clients[1].post, endpoint + path, json=body)
                if response.status_code != 200 or response.content[:4] != b'RIFF':
                    raise RuntimeError('Không khởi tạo được giọng đọc. Dừng và thử lại.')
            if config['mode'] == 'dub':
                tasks.append(asyncio.create_task(prime_voice()))
            # Do not race /generate against /health on a single-input GPU service:
            # that can create another cold container and accumulate stale speech.
            await asyncio.gather(*tasks)
            pipeline = Pipeline(recognize, synthesize, emit)
            if config['input'] in ('youtube', 'captions'):
                source_commands.put({'generation': 0, 'position': playhead})
                source_thread = SourceThread(); source_thread.start()
            await ws.send_json({'type': 'ready', 'protocol': 2})
            running = [asyncio.create_task(fn()) for fn in (sender, receiver, heartbeat)]
            tasks.extend(running)
            done, _ = await asyncio.wait(running, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except Exception as exc:
            traceback.print_exc()
            # Caption validation raises ValueError with a message that is safe
            # and needed to diagnose which cue the gateway rejected.
            message = str(exc) if isinstance(exc, (RuntimeError, ValueError)) else 'Mất kết nối pipeline. Dừng và kết nối lại.'
            try:
                await ws.send_json({'type': 'error', 'error': message})
            except Exception:
                pass
        finally:
            with anyio.CancelScope(shield=True):
                closed.set(); kill_decoder()
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                if pipeline:
                    await asyncio.to_thread(pipeline.close)
                if source_thread:
                    await asyncio.to_thread(source_thread.wait)
                await asyncio.to_thread(refill_pool.shutdown, wait=True)
                for client in clients:
                    client.close()
                if lease:
                    try:
                        await asyncio.to_thread(authorization, 'release')
                    except Exception:
                        pass
                try:
                    await ws.close()
                except Exception:
                    pass
    return api


@app.function(image=image.add_local_file('tests/python/test_pipeline.py', '/test_pipeline.py').add_local_file('tests/python/test_pipeline_gateway.py', '/test_pipeline_gateway.py').add_local_file('tests/python/test_caption_timeline.py', '/test_caption_timeline.py').add_local_file('services/realtime/gateway/realtime_pipeline.py', '/gateway_source.py'), timeout=120)
def verify_workers():
    import sys
    import unittest
    sys.path.insert(0, '/')
    from test_pipeline import PipelineTests
    from test_pipeline_gateway import GatewayTests
    from test_caption_timeline import CaptionTimelineTests
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PipelineTests)
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(GatewayTests))
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(CaptionTimelineTests))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise RuntimeError('QThread regression test failed')
    from youtube_source import resolve_audio
    import time
    started = time.monotonic()
    try:
        url, duration = resolve_audio('Hu4Yvq-g7_Y')
        from youtube_source import pcm_chunks
        chunks = list(pcm_chunks(url, 20, 6, lambda: False, lambda _: None))
        seconds = sum(item[1] for item in chunks)
        if seconds < 5.9:
            raise RuntimeError('Không lấy đủ audio từ CDN YouTube.')
        source = {'available': True, 'duration': duration, 'decodedSeconds': seconds}
    except RuntimeError as exc:
        source = {'available': False, 'error': str(exc)}
    return {'tests': result.testsRun, 'youtube': source, 'resolveSeconds': round(time.monotonic() - started, 2)}


@app.local_entrypoint()
def main():
    print(verify_workers.remote())
