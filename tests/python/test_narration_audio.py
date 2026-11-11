import io
import math
from pathlib import Path
import shutil
import struct
import sys
import unittest
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services' / 'realtime' / 'media'))
from narration_audio import fit_narration


@unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg required')
class NarrationAudioTests(unittest.TestCase):
    def audio(self, seconds):
        stream = io.BytesIO()
        with wave.open(stream, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
            wav.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(i * 2 * math.pi * 440 / 16000))) for i in range(int(seconds * 16000))))
        return stream.getvalue()

    def test_short_clip_is_not_slowed(self):
        original = self.audio(1)
        output, metrics = fit_narration(original, 3)
        self.assertEqual(output, original)
        self.assertEqual(metrics['narrationRate'], 1)

    def test_long_clip_is_shortened_with_pitch_preserved_and_speed_cap(self):
        output, metrics = fit_narration(self.audio(3), 1)
        self.assertEqual(metrics['narrationRate'], 1.35)
        with wave.open(io.BytesIO(output)) as wav:
            self.assertAlmostEqual(wav.getnframes() / wav.getframerate(), 3 / 1.35, delta=.06)
            raw = wav.readframes(wav.getnframes())
        samples = struct.unpack('<' + 'h' * (len(raw) // 2), raw)
        crossings = sum(a <= 0 < b for a, b in zip(samples, samples[1:]))
        self.assertAlmostEqual(crossings / (len(samples)/16000), 440, delta=5)
