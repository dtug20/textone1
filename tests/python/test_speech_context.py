from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services' / 'realtime' / 'speech'))
from speech_context import merge_context


class SpeechContextTests(unittest.TestCase):
    def test_removes_case_and_punctuation_insensitive_overlap(self):
        unique, combined = merge_context(
            "We need to process every spoken word.",
            "spoken word, without losing the sentence.",
        )
        self.assertEqual(unique, "without losing the sentence.")
        self.assertEqual(combined, "We need to process every spoken word. without losing the sentence.")

    def test_keeps_vietnamese_text_when_there_is_no_overlap(self):
        unique, combined = merge_context("người nói rất nhanh", "nhưng câu vẫn đủ nghĩa")
        self.assertEqual(unique, "nhưng câu vẫn đủ nghĩa")
        self.assertEqual(combined, "người nói rất nhanh nhưng câu vẫn đủ nghĩa")

    def test_uses_the_longest_overlap(self):
        unique, combined = merge_context("một hai ba hai ba", "hai ba bốn năm")
        self.assertEqual(unique, "bốn năm")
        self.assertEqual(combined, "một hai ba hai ba bốn năm")

    def test_replaces_a_cut_word_with_the_complete_overlapping_word(self):
        unique, combined = merge_context(
            "Real-time speech translation should s-",
            "should stay synchronized with the video.",
        )
        self.assertEqual(unique, "stay synchronized with the video.")
        self.assertEqual(combined, "Real-time speech translation should stay synchronized with the video.")


if __name__ == "__main__":
    unittest.main()
