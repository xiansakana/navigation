#!/bin/bash
# ECS 部署 PicList HTTP 图床服务（picgo-server）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/piclist"

if ! command -v docker >/dev/null 2>&1; then
    echo "请先安装 Docker"
    exit 1
fi

if [ ! -f .env ]; then
    cp .env.example .env
    echo "已创建 .env（请编辑 PICLIST_SERVER_KEY 与 B2 凭证）"
fi
# shellcheck disable=SC1091
source .env 2>/dev/null || true

PORT="${PICLIST_PORT:-36677}"
PUBLIC_URL="${PICLIST_PUBLIC_URL:-http://123.56.235.12:${PORT}}"
KEY="${PICLIST_SERVER_KEY:-changeme}"

if [ "$KEY" = "changeme" ] || [ "$KEY" = "换成强密钥" ]; then
    echo "警告: PICLIST_SERVER_KEY 仍为默认值，请在 .env 中设置强密钥后再暴露公网"
fi

mkdir -p data

if [ ! -f data/config.json ]; then
    cp config.example.json data/config.json
    echo "已创建 data/config.json（请填入 Backblaze B2 Application Key）"
fi

echo "==> 拉取镜像并启动 PicList（${PUBLIC_URL}）..."
docker compose pull
docker compose up -d

sleep 3
if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null \
    || docker compose ps --status running | grep -q piclist; then
    echo "PicList 已就绪: ${PUBLIC_URL}"
else
    echo "容器已启动，等待就绪…"
    docker compose logs --tail 30
fi

echo ""
echo "上传接口: ${PUBLIC_URL}/upload?key=<PICLIST_SERVER_KEY>"
echo "下一步:"
echo "  1. 编辑 piclist/.env → 设置 PICLIST_SERVER_KEY"
echo "  2. 编辑 piclist/data/config.json → 填入 B2 accessKeyID / secretAccessKey"
echo "  3. 安全组放行 TCP ${PORT}"
echo "  4. 客户端（Typora / Obsidian / PicHoro）服务器地址填 ${PUBLIC_URL}，密钥填 PICLIST_SERVER_KEY"
