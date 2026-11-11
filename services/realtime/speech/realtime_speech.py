"""Bounded EN/VI speech recognition + translation for TexTone.
Deploy: modal deploy realtime_speech.py
"""
import modal

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11")
    .pip_install("faster-whisper==1.2.1", "transformers==4.50.3", "torch==2.6.0", "sentencepiece==0.2.0", "fastapi[standard]==0.124.4")
    .add_local_python_source("speech_context")
)
app = modal.App("resonance-realtime", image=image)
cache = modal.Volume.from_name("resonance-speech-models", create_if_missing=True)

with image.imports():
    import io
    import os
    import hmac
    import wave
    import threading
    import time
    from typing import Literal
    import numpy as np
    import torch
    from faster_whisper import WhisperModel
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
    from fastapi import FastAPI, Header, HTTPException, Request
    from starlette.concurrency import run_in_threadpool
    from speech_context import merge_context


@app.cls(gpu="L4", scaledown_window=300, volumes={"/models": cache}, secrets=[modal.Secret.from_name("chatterbox-api-key")])
@modal.concurrent(max_inputs=1)
class SpeechService:
    @modal.enter()
    def load(self):
        self.lock = threading.Lock()
        self.whisper_model_id = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
        self.translation_model_id = os.environ.get("TRANSLATION_MODEL", "VietAI/envit5-translation")
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "float16")
        self.whisper = WhisperModel(self.whisper_model_id, device="cuda", compute_type=compute_type, download_root="/models")
        model_id = self.translation_model_id
        self.tokenizer = AutoTokenizer.from_pretrained(model_id, cache_dir="/models")
        self.translator = AutoModelForSeq2SeqLM.from_pretrained(model_id, cache_dir="/models", torch_dtype=torch.float16).to("cuda").eval()
        # Initialize CUDA kernels before /health reports readiness. The extension
        # captures its first bounded windows while this cold-start work runs.
        with torch.inference_mode():
            warm_segments, _ = self.whisper.transcribe(np.zeros(16000, dtype=np.float32), language="en", beam_size=1, vad_filter=False, condition_on_previous_text=False)
            list(warm_segments)
            self._translate_locked("Hello.", "en", "vi", num_beams=1, max_new_tokens=8)
            torch.cuda.synchronize()

    def _translate_locked(self, text, source, target, num_beams=3, max_new_tokens=384):
        if not text or source == target:
            return text
        if "envit5" in self.translation_model_id.casefold():
            inputs = self.tokenizer(f"{source}: {text}", return_tensors="pt", truncation=True, max_length=384).to("cuda")
            tokens = self.translator.generate(**inputs, max_new_tokens=max_new_tokens, num_beams=num_beams)
            translated = self.tokenizer.batch_decode(tokens, skip_special_tokens=True)[0].strip()
            prefix = f"{target}:"
            if translated.casefold().startswith(prefix):
                translated = translated[len(prefix):].strip()
            return translated[:1500]
        codes = {"en": "eng_Latn", "vi": "vie_Latn"}
        self.tokenizer.src_lang = codes[source]
        inputs = self.tokenizer(text, return_tensors="pt", truncation=True, max_length=384).to("cuda")
        tokens = self.translator.generate(**inputs, forced_bos_token_id=self.tokenizer.convert_tokens_to_ids(codes[target]), max_new_tokens=max_new_tokens, num_beams=num_beams)
        return self.tokenizer.batch_decode(tokens, skip_special_tokens=True)[0][:1500]

    def translate(self, text, source, target):
        started = time.perf_counter()
        with self.lock, torch.inference_mode():
            acquired = time.perf_counter()
            translated = self._translate_locked(text, source, target)
            finished = time.perf_counter()
        return {"text": text, "translatedText": translated,
                "modelTimings": {"queueMs": round((acquired - started) * 1000), "asrMs": 0,
                                 "translationMs": round((finished - acquired) * 1000)}}

    def process(self, raw, source, target, prompt="", prefix=""):
        try:
            with wave.open(io.BytesIO(raw)) as audio:
                if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000 or not 0 < audio.getnframes() <= 16000 * 12:
                    raise ValueError("Expected mono 16kHz PCM16 WAV up to twelve seconds")
                pcm = audio.readframes(audio.getnframes())
                if len(pcm) != audio.getnframes() * 2:
                    raise ValueError("Truncated audio")
                samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        except (wave.Error, ValueError, EOFError) as exc:
            raise HTTPException(422, "Invalid PCM WAV") from exc
        started = time.perf_counter()
        with self.lock, torch.inference_mode():
            acquired = time.perf_counter()
            segments, _ = self.whisper.transcribe(
                samples,
                language=source,
                beam_size=3,
                vad_filter=True,
                condition_on_previous_text=False,
                initial_prompt=prompt or None,
            )
            segments = list(segments)
            recognized = time.perf_counter()
            raw_text = " ".join(segment.text.strip() for segment in segments).strip()[:1500]
            text, source_text = merge_context(prefix, raw_text)
            translated = self._translate_locked(source_text, source, target)
            return {"text": text, "sourceText": source_text, "translatedText": translated,
                    "speechStart": max(0, segments[0].start) if segments else None,
                    "speechEnd": min(len(samples) / 16000, segments[-1].end) if segments else None,
                    "modelTimings": {"queueMs": round((acquired - started) * 1000),
                                     "asrMs": round((recognized - acquired) * 1000),
                                     "translationMs": round((time.perf_counter() - recognized) * 1000)}}

    @modal.asgi_app()
    def serve(self):
        api = FastAPI()

        @api.get("/health")
        async def health(x_api_key: str = Header(default="")):
            expected = os.environ.get("CHATTERBOX_API_KEY", "")
            if not expected or not hmac.compare_digest(x_api_key, expected):
                raise HTTPException(403, "Invalid API key")
            return {"ready": True, "asr": self.whisper_model_id, "translation": self.translation_model_id}

        @api.post("/process")
        async def process(request: Request, source: Literal["en", "vi"], target: Literal["en", "vi"], prompt: str = "", prefix: str = "", x_api_key: str = Header(default="")):
            expected = os.environ.get("CHATTERBOX_API_KEY", "")
            if not expected or not hmac.compare_digest(x_api_key, expected):
                raise HTTPException(403, "Invalid API key")
            raw = bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > 1_000_000:
                    raise HTTPException(413, "Audio too large")
            if len(prompt) > 800 or len(prefix) > 1500:
                raise HTTPException(422, "Speech context is too long")
            return await run_in_threadpool(self.process, bytes(raw), source, target, prompt, prefix)

        @api.post("/translate")
        async def translate(request: Request, source: Literal["en", "vi"], target: Literal["en", "vi"], x_api_key: str = Header(default="")):
            expected = os.environ.get("CHATTERBOX_API_KEY", "")
            if not expected or not hmac.compare_digest(x_api_key, expected):
                raise HTTPException(403, "Invalid API key")
            try:
                payload = await request.json()
                text = " ".join(payload.get("text", "").split())
            except (ValueError, AttributeError) as exc:
                raise HTTPException(422, "Invalid translation text") from exc
            if not 0 < len(text) <= 1500:
                raise HTTPException(422, "Invalid translation text")
            return await run_in_threadpool(self.translate, text, source, target)

        return api
