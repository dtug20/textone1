from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services' / 'realtime' / 'media'))
from caption_timeline import caption_items, normalize_cues


class CaptionTimelineTests(unittest.TestCase):
    def test_timeline_covers_silence_and_speech_contiguously(self):
        cues = normalize_cues([
            {'start': 2, 'duration': 3, 'text': 'Hello.', 'translatedText': 'Xin chào.'},
            {'start': 10, 'duration': 2, 'text': 'World.', 'translatedText': 'Thế giới.', 'needsTranslation': True},
        ], 20)
        items = list(caption_items(cues, 0, 20, 4))
        self.assertEqual([(item['sourceStart'], item['duration'], item['silent']) for item in items], [
            (0, 2, True), (2, 3, False), (5, 5, True), (10, 2, False), (12, 8, True),
        ])
        self.assertTrue(all(items[index]['sourceStart'] + items[index]['duration'] == items[index + 1]['sourceStart'] for index in range(len(items) - 1)))
        self.assertTrue(all(item['generation'] == 4 for item in items))
        self.assertTrue(items[3]['needsTranslation'])

    def test_seek_early_in_cue_keeps_the_whole_sentence(self):
        cues = normalize_cues([{'start': 10, 'duration': 4, 'text': 'Hello.', 'translatedText': 'Xin chào.'}], 20)
        first = next(caption_items(cues, 11, 20, 1))
        self.assertEqual(first['sourceStart'], 10)
        self.assertEqual(first['duration'], 4)
        self.assertFalse(first['silent'])

    def test_seek_late_in_cue_skips_the_sentence(self):
        cues = normalize_cues([{'start': 10, 'duration': 4, 'text': 'Hello.', 'translatedText': 'Xin chào.'}], 20)
        items = list(caption_items(cues, 13.9, 20, 1))
        self.assertTrue(items[0]['silent'])
        self.assertAlmostEqual(items[0]['sourceStart'], 13.9)
        self.assertAlmostEqual(items[0]['sourceStart'] + items[0]['duration'], 14)
        self.assertTrue(all(item['silent'] for item in items))

    def test_accepts_a_long_complete_sentence_for_read_ahead(self):
        cues = normalize_cues([{'start': 4, 'duration': 17.5, 'text': 'One complete sentence.',
                                'translatedText': 'Một câu hoàn chỉnh.'}], 30)
        self.assertEqual(cues[0]['duration'], 17.5)
        with self.assertRaisesRegex(ValueError, 'outside'):
            normalize_cues([{'start': 4, 'duration': 18.1, 'text': 'Too long.',
                             'translatedText': 'Quá dài.'}], 30)

    def test_rejects_overlap_and_missing_translation(self):
        with self.assertRaisesRegex(ValueError, 'overlap'):
            normalize_cues([
                {'start': 1, 'duration': 2, 'text': 'One', 'translatedText': 'Một'},
                {'start': 2, 'duration': 2, 'text': 'Two', 'translatedText': 'Hai'},
            ], 10)
        with self.assertRaisesRegex(ValueError, 'empty'):
            normalize_cues([{'start': 1, 'duration': 2, 'text': 'One', 'translatedText': ''}], 10)


if __name__ == '__main__':
    unittest.main()
