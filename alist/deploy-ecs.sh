#!/bin/bash
# ECS 部署 AList（仅本机 127.0.0.1:5244，经 Portal /alist/ 反代）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/alist"

PORT="${ALIST_PORT:-5244}"

if ! command -v docker >/dev/null 2>&1; then
    echo "请先安装 Docker"
    exit 1
fi

if [ -f .env ]; then
    # shellcheck disable=SC1091
    source .env 2>/dev/null || true
fi
PORT="${ALIST_PORT:-5244}"

mkdir -p data files
chmod 755 files 2>/dev/null || true

echo "==> 启动 AList（127.0.0.1:${PORT}）..."
if docker image inspect xhofe/alist:latest >/dev/null 2>&1; then
    echo "==> 本地已有镜像 xhofe/alist:latest"
else
    echo "==> 拉取 xhofe/alist:latest ..."
    docker compose pull || docker pull xhofe/alist:latest
fi

docker compose up -d

echo "==> 等待 AList 生成配置..."
for i in $(seq 1 30); do
    if [ -f data/config.json ]; then
        break
    fi
    sleep 1
done

if [ -f "$ROOT/scripts/set-alist-site-url.py" ]; then
    python3 "$ROOT/scripts/set-alist-site-url.py" || true
fi

sleep 2
if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null \
    || docker compose ps --status running | grep -q alist; then
    echo "AList 已就绪: http://127.0.0.1:${PORT}/ （Portal: /alist/）"
else
    echo "容器已启动，等待就绪…"
    docker compose logs --tail 40
fi

if [ -f "$ROOT/scripts/configure-alist.py" ]; then
    echo "==> 配置 AList 存储与站点设置..."
    python3 "$ROOT/scripts/configure-alist.py" || true
fi

echo ""
echo "管理密码文件: $ROOT/alist/data/.admin-password"
echo "  docker exec alist ./alist admin set <新密码>"
echo "Portal 入口: http://<ECS>/alist/ （需登录且有查看权限）"
