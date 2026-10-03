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
    base=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest
    archive=ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz
    curl -fL --retry 3 --connect-timeout 20 --max-time 600 "$base/$archive" -o "$work_dir/$archive"
    curl -fL --retry 3 --connect-timeout 20 --max-time 120 "$base/checksums.sha256" -o "$work_dir/checksums.sha256"
    (cd "$work_dir" && grep "  $archive\$" checksums.sha256 | sha256sum -c -)
    tar -xJf "$work_dir/$archive" -C "$work_dir" --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'
    install -m 755 "$(find "$work_dir" -type f -name ffmpeg -print -quit)" /usr/local/bin/ffmpeg
    install -m 755 "$(find "$work_dir" -type f -name ffprobe -print -quit)" /usr/local/bin/ffprobe
fi
ffmpeg -version | head -1
ffprobe -version | head -1
