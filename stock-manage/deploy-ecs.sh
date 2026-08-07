#!/bin/bash
# stock-manage ECS 部署（:5000，数据目录 data/）
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "==> 检查 Node.js..."
if ! command -v node >/dev/null 2>&1; then
    echo "安装 Node.js 20..."
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs || apt-get install -y nodejs
fi
node -v
npm -v

echo "==> 安装依赖..."
npm install

if [ ! -f config.json ]; then
    cp config.example.json config.json
    echo "已创建 config.json，请确认端口与 dataDir 后重新运行"
    exit 1
fi

mkdir -p data

echo "==> 构建前端与服务器..."
VITE_BASE_PATH=/stock-manage/ npm run build

echo "==> 安装 pm2..."
npm install -g pm2 2>/dev/null || true

echo "==> 启动 stock-manage (:5000) ..."
pm2 delete stock-manage 2>/dev/null || true
COZE_PROJECT_ENV=PROD NODE_ENV=production TRUST_PROXY=1 \
  pm2 start dist-server/server.js --name stock-manage

pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo "==> 健康检查..."
sleep 1
curl -sf -o /dev/null -w "stock-manage HTTP %{http_code}\n" http://127.0.0.1:5000/api/health || true

PUBLIC_IP="$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo '你的公网IP')"
echo ""
echo "部署完成。通过 portal 访问: http://${PUBLIC_IP}/stock-manage/"
