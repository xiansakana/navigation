#!/bin/bash
# ECS 部署思源分享服务端（Siyuan Share Web）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/siyuan-share"

PORT="${SIYUAN_SHARE_PORT:-6807}"
PUBLIC_URL="${SIYUAN_SHARE_PUBLIC_URL:-http://123.56.235.12:${PORT}}"

if ! command -v docker >/dev/null 2>&1; then
    echo "请先安装 Docker"
    exit 1
fi

if [ ! -f .env ]; then
    cp .env.example .env
fi
# shellcheck disable=SC1091
source .env 2>/dev/null || true
PORT="${SIYUAN_SHARE_PORT:-6807}"
PUBLIC_URL="${SIYUAN_SHARE_PUBLIC_URL:-http://123.56.235.12:${PORT}}"

if [ ! -f config.php ]; then
    cp config.example.php config.php
    echo "已创建 config.php（自 config.example.php）"
fi

mkdir -p data/storage data/uploads
chmod -R 775 data/storage data/uploads 2>/dev/null || true

build_share_image() {
    local build_root="$ROOT/siyuan-share/.build"
    local src_dir="$build_root/src"
    mkdir -p "$build_root"
    if [ ! -d "$src_dir/.git" ]; then
        echo "==> 克隆 siyuan-plugin-share 源码..."
        git clone --depth 1 https://github.com/b8l8u8e8/siyuan-plugin-share.git "$src_dir"
    fi
    local dockerfile="$src_dir/php-site/Dockerfile"
    if ! grep -q 'mirrors.aliyun.com' "$dockerfile"; then
        python3 - "$dockerfile" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
needle = "RUN set -eux; \\"
insert = (
    "RUN set -eux; \\\n"
    "    sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories; \\"
)
if "mirrors.aliyun.com" not in text:
    text = text.replace(needle, insert, 1)
    open(path, "w", encoding="utf-8").write(text)
PY
        echo "已注入 Alpine 国内源（mirrors.aliyun.com）"
    fi
    echo "==> 构建镜像（ECS 国内源，约 3–8 分钟）..."
    docker build -t b8l8u8e8/siyuan-share-web:latest -f "$dockerfile" "$src_dir"
}

if docker image inspect b8l8u8e8/siyuan-share-web:latest >/dev/null 2>&1; then
    echo "==> 本地已有镜像，跳过拉取/构建"
elif docker compose pull 2>/dev/null; then
    echo "==> 已从 Docker Hub 拉取镜像"
else
    echo "Docker Hub 不可用，从源码构建..."
    pkill -f 'docker build.*siyuan-share-web' 2>/dev/null || true
    build_share_image
fi

echo "==> 启动思源分享服务（${PUBLIC_URL}）..."
docker compose up -d

sleep 3
if curl -sf -o /dev/null "${PUBLIC_URL}/login" 2>/dev/null || curl -sf -o /dev/null "http://127.0.0.1:${PORT}/login"; then
    echo "思源分享已就绪: ${PUBLIC_URL}"
else
    echo "容器已启动，等待就绪…"
    docker compose logs --tail 30
fi

echo ""
echo "下一步："
echo "  1. 浏览器打开 ${PUBLIC_URL} 注册账号"
echo "  2. 登录后在网站生成 API Key"
echo "  3. 思源 /notes/ → 插件「思源分享」→ 服务端地址填 ${PUBLIC_URL}，粘贴 API Key"
echo "  4. 分享链接形如 ${PUBLIC_URL}/s/xxxxxxxx"
