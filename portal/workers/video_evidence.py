"""Local-only video evidence extraction. Progress is newline-delimited JSON."""
import argparse
import json
import math
import os
import pathlib
import subprocess
import sys
from time import perf_counter
import wave

os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'


def emit(stage, progress, **extra):
    print(json.dumps({'stage': stage, 'progress': progress, **extra}, ensure_ascii=False), flush=True)


def clock(seconds):
    seconds = max(0, int(seconds))
    return f'{seconds // 60:02d}:{seconds % 60:02d}'


def command(args):
    p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       timeout=7200, creationflags=0x08000000 if os.name == 'nt' else 0)
    if p.returncode:
        raise RuntimeError('FFmpeg 处理失败：' + p.stderr.decode('utf8', errors='replace')[-800:])


def append_segment(transcript, start, end, text, duration):
    end = min(end, duration)
    if not text.strip() or transcript and end <= transcript[-1]['end']:
        return
    if transcript:
        start = max(start, transcript[-1]['end'])
    if start < end:
        transcript.append({'start': round(start, 3), 'end': round(end, 3), 'text': text.strip()})


def main():
    started_at = perf_counter()
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    parser.add_argument('--model', default='small')
    parser.add_argument('--model-cache', default='')
    parser.add_argument('--device', choices=['cpu', 'cuda', 'auto'], default='cpu')
    parser.add_argument('--language', default='')
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--max-duration', type=int, default=14400)
    args = parser.parse_args()
    # Keep imports after argument parsing so --help is usable before installation.
    import av
    import numpy as np
    from PIL import Image, ImageChops, ImageStat
    from faster_whisper import WhisperModel, BatchedInferencePipeline
    import ctranslate2
    from video_runtime import prepare_cuda
    handles = prepare_cuda()
    out = pathlib.Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    input_file = str(pathlib.Path(args.input).resolve())
    with av.open(input_file, options={'protocol_whitelist': 'file,pipe', 'format_whitelist': 'mov,matroska,webm'}) as container:
        duration = float(container.duration or 0) / av.time_base
        has_audio = bool(container.streams.audio)
        if not container.streams.video:
            raise RuntimeError('上传文件中没有视频轨')
    if not math.isfinite(duration) or not 0 < duration <= args.max_duration:
        raise RuntimeError('视频时长无效或超过4小时')
    ff = [args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
          '-format_whitelist', 'mov,matroska,webm', '-threads', '1', '-i', input_file]
    emit('提取关键画面', 5)
    sample = out / 'samples'
    sample.mkdir(exist_ok=True)
    interval = max(0.1, min(2.0, duration / 2), duration / 180)
    command(ff + ['-an', '-vf', f'fps=1/{interval},scale=1280:720:force_original_aspect_ratio=decrease',
                  '-frames:v', '181', '-threads', '1', '-filter_threads', '1', '-q:v', '4', str(sample / '%04d.jpg')])
    # Preserve changes plus periodic coverage. Selection is heuristic, never full-frame coverage.
    chosen = []
    previous = None
    last_time = -10000
    for i, p in enumerate(sorted(sample.glob('*.jpg'))):
        time = min(duration, i * interval + interval / 2)
        with Image.open(p) as image:
            thumb = image.convert('L').resize((96, 54))
        change = 255 if previous is None else ImageStat.Stat(ImageChops.difference(previous, thumb)).mean[0]
        if previous is None or change > 12 or time - last_time >= max(30, duration / 20):
            chosen.append((time, p)); previous = thumb; last_time = time
    if len(chosen) > 36:
        chosen = [chosen[round(i * (len(chosen) - 1) / 35)] for i in range(36)]
    frames = []
    for i, (time, source) in enumerate(chosen):
        name = f'frame-{i+1}.jpg'
        with Image.open(source) as image:
            rgb = image.convert('RGB')
            for quality in [78, 65, 50, 35]:
                rgb.save(out / name, 'JPEG', quality=quality)
                if (out / name).stat().st_size <= 250000:
                    break
            if (out / name).stat().st_size > 250000:
                rgb.thumbnail((960, 540))
                rgb.save(out / name, 'JPEG', quality=35)
        frames.append({'time': round(time, 3), 'name': name})
    for p in sample.glob('*.jpg'):
        p.unlink()
    sample.rmdir()
    transcript = []
    warnings = []
    detected = args.language
    if has_audio:
        emit('提取音频', 12)
        audio_path = out / 'audio.wav'
        command(ff + ['-vn', '-ac', '1', '-ar', '16000', '-threads', '1', str(audio_path)])
        emit('加载语音模型（首次需下载）', 15)
        model_started = perf_counter()
        device = args.device
        if device == 'auto':
            device = 'cuda' if ctranslate2.get_cuda_device_count() else 'cpu'
        model = WhisperModel(args.model, device=device, compute_type='float16' if device == 'cuda' else 'int8',
                             cpu_threads=max(1, min(8, args.threads)), download_root=args.model_cache or None)
        model_seconds = perf_counter() - model_started
        asr_started = perf_counter()
        hardware = 'GPU CUDA' if device == 'cuda' else 'CPU'
        emit('语音转写 · ' + hardware + ' · 准备音频批次', 18)
        # Decode WAV ourselves to avoid PyAV version-specific metadata options.
        pipeline = BatchedInferencePipeline(model=model)
        # Bounded 10-minute windows prevent multi-hour WAVs from exhausting server RAM.
        with wave.open(str(audio_path), 'rb') as wav:
            total = wav.getnframes()
            start = 0
            while start < total:
                wav.setpos(start)
                audio = np.frombuffer(wav.readframes(16000 * 600), dtype=np.int16).astype(np.float32) / 32768.0
                offset = start / 16000
                segments, info = pipeline.transcribe(audio, language=args.language or detected or None,
                    batch_size=4 if device == 'cuda' else 1, beam_size=3, vad_filter=True,
                    repetition_penalty=1.15, no_repeat_ngram_size=4, condition_on_previous_text=False)
                detected = info.language
                for segment in segments:
                    absolute_start, absolute_end = offset + segment.start, offset + segment.end
                    append_segment(transcript, absolute_start, absolute_end, segment.text, duration)
                    emit(f'语音转写 · {hardware} · {clock(absolute_end)}/{clock(duration)} · 已用{clock(perf_counter() - asr_started)}',
                         18 + min(45, int(absolute_end / duration * 45)))
                if start + len(audio) >= total:
                    break
                start += 16000 * 598  # overlap: skip fully covered segments, retain new speech
        emit('语音转写完成 · ' + hardware, 63, metrics={
            'device': device, 'audioSeconds': round(duration, 3), 'modelLoadSeconds': round(model_seconds, 3),
            'asrSeconds': round(perf_counter() - asr_started, 3), 'segments': len(transcript)})
        audio_path.unlink(missing_ok=True)
        if not transcript:
            warnings.append('未识别到有效语音；笔记仅能依据抽取画面。')
    else:
        warnings.append('视频没有音轨；笔记仅能依据抽取画面。')
    result = {'duration': duration, 'language': detected, 'frames': frames, 'transcript': transcript,
              'asrModel': args.model, 'warnings': warnings}
    (out / 'evidence.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    emit('素材提取完成', 65, metrics={'extractionSeconds': round(perf_counter() - started_at, 3)})


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(str(e), file=sys.stderr, flush=True)
        sys.exit(1)
