#!/bin/bash
# qqq-dip ECS 部署（:5001）
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
    echo "已创建 config.json，请填入 API Key / QQ token 后重新运行"
    exit 1
fi

mkdir -p data

echo "==> 启动 qqq-dip..."
npm install -g pm2 2>/dev/null || true
pm2 delete qqq-dip 2>/dev/null || true
TRUST_PROXY=1 pm2 start src/server.js --name qqq-dip
pm2 save

sleep 1
curl -sf -o /dev/null -w "qqq-dip HTTP %{http_code}\n" http://127.0.0.1:5001/api/health || true
echo "部署完成。portal 访问: /stock-manage/dip/"
