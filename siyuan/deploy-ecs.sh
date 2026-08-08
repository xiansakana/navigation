#!/bin/bash
# 在 ECS 上部署思源笔记（Docker），替换自研 notes 服务
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/siyuan"

echo "==> 检查 Docker..."
if ! command -v docker >/dev/null 2>&1; then
    echo "请先安装 Docker"
    exit 1
fi

if [ ! -f .env ]; then
    cp .env.example .env
    AUTH="$(openssl rand -hex 8 2>/dev/null || echo "siyuan-$(date +%s)")"
    sed -i "s/请改成强密码/${AUTH}/" .env
    echo "已创建 siyuan/.env，锁屏密码: ${AUTH}"
    echo "（首次经 Portal /notes/ 打开时需在思源界面输入此密码）"
fi

mkdir -p data/siyuan
chown -R 1000:1000 data/siyuan 2>/dev/null || true

echo "==> 启动思源笔记容器..."
docker compose pull
docker compose up -d

echo "==> 停止旧 notes 进程（若存在）..."
pm2 delete notes 2>/dev/null || true

sleep 2
if curl -sf -o /dev/null "http://127.0.0.1:6806/"; then
    echo "思源内核已就绪（本机 127.0.0.1:6806）"
else
    echo "容器已启动，等待内核就绪…"
    docker compose logs --tail 20
fi

if curl -sf -o /dev/null "http://127.0.0.1:6808/publish/"; then
    echo "思源发布站已就绪（本机 127.0.0.1:6808，Portal /publish/）"
else
    echo "提示: 发布站端口 6808 未响应，请在思源 设置→发布服务 中开启"
fi

echo ""
echo "编辑笔记: Portal /notes/"
echo "公开发布: Portal /publish/ （需在思源设置中开启发布服务并标记公开笔记本）"
