import unittest
from video_evidence import append_segment


class WindowBoundaryTests(unittest.TestCase):
    def test_overlap_retains_speech_after_previous_window(self):
        transcript = [{'start': 580, 'end': 600, 'text': 'previous'}]
        append_segment(transcript, 598, 628, ' new speech ', 1200)
        self.assertEqual(transcript[-1], {'start': 600, 'end': 628, 'text': 'new speech'})

    def test_fully_covered_or_past_duration_segments_are_skipped(self):
        transcript = [{'start': 580, 'end': 600, 'text': 'previous'}]
        append_segment(transcript, 598, 600, 'duplicate', 600)
        append_segment(transcript, 600, 604, 'past duration', 600)
        self.assertEqual(len(transcript), 1)


if __name__ == '__main__':
    unittest.main()
