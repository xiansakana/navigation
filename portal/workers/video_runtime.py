"""Shared CUDA library discovery for readiness checks and transcription."""
import ctypes
import os
import pathlib
import sys


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
