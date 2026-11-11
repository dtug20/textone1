import threading
import time
import unittest
import sys
if sys.platform != 'linux':
    raise unittest.SkipTest('QThread integration runs on Linux: modal run realtime_pipeline.py')
try:
    from pipeline_core import Pipeline
except ModuleNotFoundError:
    raise unittest.SkipTest('Install PySide6-Essentials or run modal run realtime_pipeline.py')


class PipelineTests(unittest.TestCase):
    def test_recognition_overlaps_previous_tts(self):
        first_tts = threading.Event()
        second_asr = threading.Event()
        results = []
        def recognize(item):
            if item['sequence'] == 2:
                self.assertTrue(first_tts.wait(2))
                second_asr.set()
            return item
        def synthesize(item):
            if item['sequence'] == 1:
                first_tts.set()
                self.assertTrue(second_asr.wait(2))
            return item
        pipeline = Pipeline(recognize, synthesize, results.append)
        try:
            pipeline.submit({'sequence': 1, 'generation': 0})
            pipeline.submit({'sequence': 2, 'generation': 0})
            deadline = time.monotonic() + 3
            while len(results) < 2 and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual([x['sequence'] for x in results], [1, 2])
        finally:
            pipeline.close()

    def test_seek_discards_in_flight_result(self):
        entered = threading.Event()
        release = threading.Event()
        results = []
        def recognize(item):
            entered.set(); release.wait(2)
            return item
        pipeline = Pipeline(recognize, lambda item: item, results.append)
        try:
            pipeline.submit({'sequence': 1, 'generation': 0})
            self.assertTrue(entered.wait(2))
            pipeline.reset(1); release.set()
            pipeline.submit({'sequence': 2, 'generation': 1})
            deadline = time.monotonic() + 2
            while not results and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual([x['sequence'] for x in results], [2])
        finally:
            release.set(); pipeline.close()

    def test_backpressure_releases_on_stop(self):
        entered = threading.Event(); release = threading.Event()
        def recognize(item):
            entered.set(); release.wait(2)
            return item
        pipeline = Pipeline(recognize, lambda item: item, lambda _: None)
        pipeline.submit({'generation': 0})
        self.assertTrue(entered.wait(2))
        pipeline.audio.put({'generation': 0}); pipeline.audio.put({'generation': 0})
        done = threading.Event()
        thread = threading.Thread(target=lambda: (pipeline.put(pipeline.audio, {'generation': 0}), done.set()))
        thread.start(); pipeline.closed.set(); release.set()
        self.assertTrue(done.wait(2))
        thread.join(); pipeline.close()


if __name__ == '__main__':
    unittest.main()
