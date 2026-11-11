import io
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services' / 'realtime' / 'media'))
from youtube_source import pcm_chunks


class _Process:
    def __init__(self, pcm):
        self.stdout = io.BytesIO(pcm)

    def poll(self):
        return 0

    def wait(self, timeout=None):
        return 0

    def kill(self):
        pass


class YouTubeSourceTests(unittest.TestCase):
    def test_adaptive_chunks_end_on_sustained_quiet_boundary(self):
        tone = struct.pack('<h', 2000) * (16000 * 5)
        quiet = b'\0\0' * round(16000 * 0.4)
        tail = struct.pack('<h', 2000) * 16000
        process = _Process(tone + quiet + tail)
        with patch('youtube_source.subprocess.Popen', return_value=process):
            chunks = list(pcm_chunks(
                'https://example.invalid/audio', 12, 20, lambda: False,
                lambda _: None, chunk_seconds=10, adaptive=True,
            ))
        self.assertEqual(len(chunks), 2)
        self.assertAlmostEqual(chunks[0][0], 12)
        self.assertGreaterEqual(chunks[0][1], 5.34)
        self.assertLess(chunks[0][1], 5.4)
        self.assertAlmostEqual(chunks[1][0], 12 + chunks[0][1])

    def test_adaptive_chunks_bound_continuous_speech(self):
        tone = struct.pack('<h', 2000) * (16000 * 12)
        process = _Process(tone)
        with patch('youtube_source.subprocess.Popen', return_value=process):
            chunks = list(pcm_chunks(
                'https://example.invalid/audio', 0, 20, lambda: False,
                lambda _: None, chunk_seconds=10, adaptive=True,
            ))
        self.assertEqual([round(item[1], 2) for item in chunks], [10, 2])

    def test_adaptive_chunks_keep_long_leading_silence_out_of_speech(self):
        quiet = b'\0\0' * (16000 * 2)
        tone = struct.pack('<h', 2000) * (16000 * 5)
        process = _Process(quiet + tone)
        with patch('youtube_source.subprocess.Popen', return_value=process):
            chunks = list(pcm_chunks(
                'https://example.invalid/audio', 0, 20, lambda: False,
                lambda _: None, chunk_seconds=10, adaptive=True,
            ))
        self.assertEqual(len(chunks), 2)
        self.assertAlmostEqual(chunks[0][1], 2, places=2)
        self.assertEqual(chunks[1][2][:2], struct.pack('<h', 2000))


if __name__ == '__main__':
    unittest.main()
