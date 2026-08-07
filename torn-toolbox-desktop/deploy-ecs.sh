#!/bin/bash
# torn-toolbox-desktop 阿里云 ECS 部署（压价 :8790 + 公司 :8791 独立进程）
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
npm install --production

echo "==> 安装 pm2..."
npm install -g pm2

if [ -f config.json ] && { [ ! -f config.undercut.json ] || [ ! -f config.company.json ]; }; then
    echo "==> 迁移旧版 config.json ..."
    node scripts/migrate-config.mjs
fi

if [ ! -f config.undercut.json ]; then
    cp config.undercut.example.json config.undercut.json
    echo "已创建 config.undercut.json，请编辑后重新运行"
    exit 1
fi

if [ ! -f config.company.json ]; then
    cp config.company.example.json config.company.json
    echo "已创建 config.company.json，请编辑后重新运行"
    exit 1
fi

echo "==> 启动 torn-undercut (:8790) ..."
pm2 delete torn-undercut 2>/dev/null || true
pm2 delete torn-toolbox 2>/dev/null || true
pm2 delete torn-desktop 2>/dev/null || true
pm2 start src/server-undercut.js --name torn-undercut

echo "==> 启动 torn-company (:8791) ..."
pm2 delete torn-company 2>/dev/null || true
pm2 start src/server-company.js --name torn-company

pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo "==> 健康检查..."
sleep 1
curl -sf -o /dev/null -w "undercut HTTP %{http_code}\n" http://127.0.0.1:8790/ || true
curl -sf -o /dev/null -w "company HTTP %{http_code}\n" http://127.0.0.1:8791/ || true

PUBLIC_IP="$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo '你的公网IP')"
echo ""
echo "部署完成。"
echo "通过 portal 访问: http://${PUBLIC_IP}/ → Torn 工具箱"
echo "  - 压价助手: /torn-toolbox/undercut/"
echo "  - 公司监听: /torn-toolbox/company/"
