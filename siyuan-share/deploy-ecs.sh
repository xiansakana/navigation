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

echo "==> 拉取镜像 b8l8u8e8/siyuan-share-web:latest ..."
if ! docker compose pull; then
    echo "Docker Hub 拉取失败，尝试从 GitHub 源码构建（较慢）..."
    BUILD_DIR="$(mktemp -d)"
    trap 'rm -rf "$BUILD_DIR"' EXIT
    git clone --depth 1 https://github.com/b8l8u8e8/siyuan-plugin-share.git "$BUILD_DIR/src"
    docker build -t b8l8u8e8/siyuan-share-web:latest -f "$BUILD_DIR/src/php-site/Dockerfile" "$BUILD_DIR/src"
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
echo "  4. 若外网无法访问，请在阿里云安全组放行 TCP ${PORT}"
