"""Exercise the deployed model critical section without requiring a local GPU."""
from collections import OrderedDict
import ast
import concurrent.futures
import io
from pathlib import Path
import threading
import time
import unittest


class Model:
    def __init__(self):
        self.active = 0
        self.max_active = 0
        self.fail = False
        self.prepared = []
        self.conds = None

    def prepare_conditionals(self, path, exaggeration):
        self.prepared.append((path, exaggeration))
        self.conds = path

    def generate(self, **kwargs):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            time.sleep(0.01)
            if self.fail:
                self.fail = False
                raise RuntimeError('generation failed')
            return (kwargs['audio_prompt'] or self.conds).encode()
        finally:
            self.active -= 1

    def save_audio(self, audio, path):
        Path(path).write_bytes(audio)


def service():
    tree = ast.parse(Path('viterbox_tts.py').read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'ViterboxService')
    methods = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name in ('_generate_audio', '_generate_locked')]
    for method in methods:
        method.decorator_list = []
    scope = {'io': io}
    exec(compile(ast.fix_missing_locations(ast.Module(body=methods, type_ignores=[])), '<viterbox critical section>', 'exec'), scope)
    instance = type('Service', (), {name: scope[name] for name in ('_generate_audio', '_generate_locked')})()
    instance.model_lock = threading.Lock()
    instance.model = Model()
    instance.voice_conditions = OrderedDict()
    return instance


class ConcurrencyTest(unittest.TestCase):
    def test_simultaneous_voice_requests_never_overlap_shared_model(self):
        svc = service()
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            results = list(pool.map(lambda i: svc._generate_audio('hello', f'voice-{i}', split_sentences=False), range(5)))
        self.assertEqual(svc.model.max_active, 1)
        self.assertEqual(results, [f'voice-{i}'.encode() for i in range(5)])

    def test_cached_voice_is_reused_and_switching_restores_correct_voice(self):
        svc = service()
        for voice in ('a', 'b', 'a'):
            self.assertEqual(svc._generate_audio('hello', voice, voice_cache_key=(voice, 1, 10)), voice.encode())
        self.assertEqual(svc.model.prepared, [('a', 0.5), ('b', 0.5)])

    def test_voice_version_exaggeration_and_lru_are_part_of_cache_identity(self):
        svc = service()
        svc._generate_audio('hello', 'a', voice_cache_key=('a', 1, 10))
        svc._generate_audio('hello', 'a', voice_cache_key=('a', 2, 10))
        svc._generate_audio('hello', 'a', exaggeration=0.8, voice_cache_key=('a', 2, 10))
        self.assertEqual(len(svc.model.prepared), 3)
        for i in range(10):
            svc._generate_audio('hello', str(i), voice_cache_key=(str(i), 1, 10))
        self.assertEqual(len(svc.voice_conditions), 8)
        self.assertNotIn(('a', 1, 10, 0.5), svc.voice_conditions)

    def test_failure_releases_model_lock(self):
        svc = service()
        svc.model.fail = True
        with self.assertRaises(RuntimeError):
            svc._generate_audio('hello', 'voice-a')
        self.assertFalse(svc.model_lock.locked())
        self.assertEqual(svc._generate_audio('hello', 'voice-b'), b'voice-b')


if __name__ == '__main__':
    unittest.main()
