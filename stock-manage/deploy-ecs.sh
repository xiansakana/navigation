#!/bin/bash
# stock-manage ECS 部署（:5000，JSON 持久化）
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "==> 检查 Node.js..."
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs || apt-get install -y nodejs
fi

echo "==> 安装依赖..."
npm install --production

if [ ! -f config.json ]; then
    cp config.example.json config.json
    echo "已创建 config.json，请确认后重新运行"
    exit 1
fi

mkdir -p data

echo "==> 启动 stock-manage..."
npm install -g pm2 2>/dev/null || true
pm2 delete stock-manage 2>/dev/null || true
TRUST_PROXY=1 pm2 start src/server.js --name stock-manage
pm2 save

sleep 1
curl -sf -o /dev/null -w "stock-manage HTTP %{http_code}\n" http://127.0.0.1:5000/api/health || true
echo "部署完成。portal 访问: /stock-manage/"
