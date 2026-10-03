#!/bin/bash
set -euo pipefail
if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then exit 0; fi
echo "==> 安装博客 MP4 压缩及缩略图组件"
if command -v apt-get >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg
else
    # Alibaba Cloud Linux: the static builds linked by ffmpeg.org avoid adding OS repositories.
    if [[ "$(uname -m)" != x86_64 ]]; then echo "请安装适用于当前架构的 ffmpeg 和 ffprobe" >&2; exit 1; fi
    work_dir="$(mktemp -d /tmp/navigation-ffmpeg.XXXXXX)"
    trap 'rm -rf -- "$work_dir"' EXIT
    archive=ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz
    python3 - "$work_dir/$archive" "$archive" <<'PY'
import hashlib, json, re, sys, urllib.request
destination, name = sys.argv[1:]
headers = {'User-Agent': 'navigation-media-installer'}
request = urllib.request.Request('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest', headers=headers)
with urllib.request.urlopen(request, timeout=30) as response:
    release = json.load(response)
asset = next(item for item in release['assets'] if item['name'] == name)
expected = asset.get('digest', '').removeprefix('sha256:')
if not re.fullmatch('[0-9a-f]{64}', expected):
    raise RuntimeError('FFmpeg release SHA256 is missing')
request = urllib.request.Request(asset['url'], headers={**headers, 'Accept': 'application/octet-stream'})
digest, total, reported = hashlib.sha256(), 0, 0
with urllib.request.urlopen(request, timeout=60) as response, open(destination, 'wb') as output:
    if response.headers.get_content_type() != 'application/octet-stream':
        raise RuntimeError('FFmpeg release did not return a binary archive')
    while True:
        block = response.read(1024 * 1024)
        if not block: break
        output.write(block); digest.update(block); total += len(block)
        if total - reported >= 10 * 1024 * 1024:
            print('FFmpeg download: %d / %d MB' % (total // 1048576, asset['size'] // 1048576), flush=True)
            reported = total
if total != asset['size'] or digest.hexdigest() != expected:
    raise RuntimeError('FFmpeg release SHA256 mismatch')
print('FFmpeg SHA256 verified:', expected, flush=True)
PY
    tar -xJf "$work_dir/$archive" -C "$work_dir" --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'
    install -m 755 "$(find "$work_dir" -type f -name ffmpeg -print -quit)" /usr/local/bin/ffmpeg
    install -m 755 "$(find "$work_dir" -type f -name ffprobe -print -quit)" /usr/local/bin/ffprobe
fi
ffmpeg -version | head -1
ffprobe -version | head -1
