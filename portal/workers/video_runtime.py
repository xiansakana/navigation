"""Shared CUDA library discovery for readiness checks and transcription."""
import ctypes
import os
import pathlib
import sys
import time
import contextlib
import tempfile
import errno


def speech_prompt(profile='general', hotwords=''):
    terms = '正印、印星、印庇、生身、禄、十神、官杀、食神、伤官、大运、流年。' if profile == 'bazi' else ''
    return '简体中文。' + hotwords[:120] + ('。' if hotwords else '') + terms


@contextlib.contextmanager
def gpu_asr_slot(waiting=lambda: None, lock_path=None):
    # All media processes of this login share one GPU ASR slot; extraction and
    # remote summaries remain concurrent. OS releases the lock on process exit.
    filename = lock_path or pathlib.Path(tempfile.gettempdir()) / ('navigation-asr-' + str(getattr(os, 'getuid', lambda: 'user')()) + '.lock')
    with open(filename, 'a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0'); handle.flush()
        while True:
            try:
                handle.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                waiting(); time.sleep(1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def prepare_cuda():
    handles = []
    if os.name == 'nt':
        for directory in (pathlib.Path(sys.prefix) / 'Lib/site-packages/nvidia').glob('*/bin'):
            os.environ['PATH'] = str(directory) + os.pathsep + os.environ.get('PATH', '')
            handles.append(os.add_dll_directory(str(directory)))
    return handles


def probe(device):
    import av
    import ctranslate2
    import faster_whisper
    from PIL import Image
    handles = prepare_cuda()
    gpu = ctranslate2.get_cuda_device_count() > 0
    if device == 'cuda' and not gpu:
        raise RuntimeError('CUDA unavailable')
    resolved = 'cuda' if device in ('cuda', 'auto') and gpu else 'cpu'
    if resolved == 'cuda' and os.name == 'nt':
        handles.extend(ctypes.CDLL(name) for name in ('cublas64_12.dll', 'cudnn64_9.dll'))
    return resolved


if __name__ == '__main__':
    print(probe(sys.argv[1] if len(sys.argv) > 1 else 'cpu'))
