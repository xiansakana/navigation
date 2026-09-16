#!/bin/bash
# qq-bot 阿里云 ECS 一键部署（在 /opt/qq-bot 目录下运行）
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

echo "==> 安装 pm2..."
npm install -g pm2

if [ ! -f config.json ]; then
    cp config.example.json config.json
    echo "已创建 config.json，请编辑后重新运行本脚本"
    echo "  nano config.json"
    echo "必改项:"
    echo "  - server.host = 127.0.0.1（仅由 Portal 反代访问）"
    echo "  - server.notifyToken = 强随机字符串"
    echo "  - napcat.accessToken = ECS 上 NapCat 的 HTTP Token"
    exit 1
fi

echo "==> 启动 qq-bot..."
pm2 delete qq-bot 2>/dev/null || true
pm2 start src/server.js --name qq-bot
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo "==> 本机健康检查..."
sleep 1
curl -s http://127.0.0.1:8787/health
echo ""
echo "部署完成。请通过 Portal 的 /notifications/ 访问管理页面。"
