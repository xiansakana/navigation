import unittest
import subprocess
import tempfile
import pathlib
import sys
from video_runtime import speech_prompt, gpu_asr_slot
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


class SpeechRuntimeTests(unittest.TestCase):
    def test_short_prompt_preserves_terms_without_adding_instructions(self):
        self.assertIn('正印', speech_prompt('bazi'))
        self.assertNotIn('正印', speech_prompt('general'))
        self.assertIn('印绶', speech_prompt('bazi', '印绶'))
        self.assertLess(len(speech_prompt('bazi', '字' * 200)), 180)

    def test_gpu_slot_excludes_other_process_and_releases_after_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = pathlib.Path(directory) / 'gpu.lock'
            script = "from video_runtime import gpu_asr_slot; import pathlib;\nwith gpu_asr_slot(lock_path=pathlib.Path(" + repr(str(lock)) + ")): print('acquired')"
            try:
                with gpu_asr_slot(lock_path=lock):
                    with self.assertRaises(subprocess.TimeoutExpired):
                        subprocess.run([sys.executable, '-c', script], cwd=pathlib.Path(__file__).parent, capture_output=True, timeout=0.5)
                    raise ValueError('release on exception')
            except ValueError:
                pass
            result = subprocess.run([sys.executable, '-c', script], cwd=pathlib.Path(__file__).parent, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), b'acquired')


if __name__ == '__main__':
    unittest.main()
