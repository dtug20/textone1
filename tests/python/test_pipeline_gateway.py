"""Exercise WebSocket protocol and actual Qt workers with deterministic GPU boundaries."""
import ast
import io
import os
import struct
import threading
import unittest
import wave
from pathlib import Path
from unittest.mock import patch
import sys
if sys.platform != 'linux':
    raise unittest.SkipTest('Gateway integration runs on Linux Modal')
try:
    import httpx
    from fastapi.testclient import TestClient
except ModuleNotFoundError:
    raise unittest.SkipTest('Run modal run realtime_pipeline.py with gateway dependencies')


class GatewayTests(unittest.TestCase):
    def test_two_chunks_overlap_and_return_ordered_audio(self):
        tree = ast.parse(Path('/gateway_source.py').read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'serve')
        function.decorator_list = []
        namespace = {}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'gateway', 'exec'), namespace)
        second_asr = threading.Event()
        asr_count = 0
        tts_count = 0
        speech_requests = []
        stream = io.BytesIO()
        with wave.open(stream, 'wb') as writer:
            writer.setnchannels(1); writer.setsampwidth(2); writer.setframerate(16000); writer.writeframes(bytes(32000))

        class GPUClient:
            def __init__(self, **kwargs): pass
            def close(self): pass
            def post(self, url, **kwargs):
                nonlocal asr_count, tts_count
                if url.endswith('/process'):
                    asr_count += 1
                    if asr_count == 2: second_asr.set()
                    with wave.open(io.BytesIO(kwargs['content'])) as audio:
                        seconds = audio.getnframes() / audio.getframerate()
                    speech_requests.append({'seconds':seconds, **kwargs.get('params', {})})
                    complete = seconds > 3
                    source_text = 'hello world' if complete else 'hello'
                    return httpx.Response(200, json={'text':source_text,'sourceText':source_text,
                                                     'translatedText':'xin chao the gioi' if complete else 'xin chao',
                                                     'speechStart':0,'speechEnd':1})
                if kwargs.get('json', {}).get('prompt') == 'Xin chào.':
                    return httpx.Response(200, content=stream.getvalue())
                tts_count += 1
                if tts_count == 1 and not second_asr.wait(3): raise RuntimeError('STT failed to overlap TTS')
                return httpx.Response(200, content=stream.getvalue())

        class WarmClient:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def get(self, url, **kwargs):
                return httpx.Response(200, request=httpx.Request('GET', url))

        def authorize(url, **kwargs):
            if kwargs['json']['action'] == 'acquire':
                self.assertNotIn('lease', kwargs['json'], 'Initial lease must be omitted, not JSON null')
            else:
                self.assertIsInstance(kwargs['json']['lease'], str)
            return httpx.Response(200, json={'lease':'2026-01-01T00:00:00.000Z','budget':5 if kwargs['json']['action']=='acquire' else 0,
                                           'source':'en','target':'vi','mode':'dub','voice':'test','expires':9999999999999})
        with patch.dict(os.environ, {'PIPELINE_APP_URL':'https://app.test','CHATTERBOX_API_KEY':'test', 'REALTIME_API_URL':'https://speech.test', 'VITERBOX_API_URL':'https://tts.test'}):
            api = namespace['serve']()
            client = TestClient(api)
            with patch('httpx.post', authorize), patch('httpx.Client', GPUClient), patch('httpx.AsyncClient', WarmClient):
                with client.websocket_connect('/stream') as ws:
                    ws.send_json({'token':'test','input':'tab','protocol':2})
                    self.assertEqual(ws.receive_json()['type'], 'ready')
                    for sequence in range(2):
                        ws.send_bytes(struct.pack('<IIdB3x', 0, sequence, float(sequence), 1) + bytes(32000))
                    audio = []
                    while len(audio) < 2:
                        event = ws.receive_json()
                        self.assertNotEqual(event['type'], 'error', event)
                        if event['type']=='audio': audio.append(event)
                    self.assertEqual([item['sequence'] for item in audio], [0,1])
                    self.assertTrue(all(item['audio'] for item in audio))
                    ws.send_bytes(struct.pack('<IIdB3x', 0, 10, 10.0, 0) + bytes(64000))
                    partial = ws.receive_json()
                    while partial.get('sequence') != 10 or partial.get('type') != 'transcript':
                        partial = ws.receive_json()
                    self.assertTrue(partial['partial'])
                    self.assertEqual(partial['translatedText'], '')
                    ws.send_bytes(struct.pack('<IIdB3x', 0, 11, 11.68, 0) + bytes(64000))
                    merged = ws.receive_json()
                    while merged.get('sequence') != 11 or merged.get('type') != 'audio':
                        merged = ws.receive_json()
                    self.assertEqual(merged['text'], 'hello world')
                    self.assertAlmostEqual(merged['duration'], 3.68, places=2)
                    self.assertEqual(speech_requests[-2]['target'], 'en')
                    self.assertAlmostEqual(speech_requests[-2]['seconds'], 2, places=2)
                    self.assertEqual(speech_requests[-1]['target'], 'vi')
                    self.assertAlmostEqual(speech_requests[-1]['seconds'], 3.68, places=2)


if __name__ == '__main__': unittest.main()
