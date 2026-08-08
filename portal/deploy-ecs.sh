#!/bin/bash
# portal 阿里云 ECS 部署（:80 服务导航，含 Torn 压价助手等）
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "==> 检查 Node.js..."
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs || apt-get install -y nodejs
fi
node -v

if [ ! -f config.json ]; then
    cp config.ecs.example.json config.json
    echo "已创建 config.json，请编辑 auth 与 services 后重新运行"
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/scripts/patch-portal-config.py" ]; then
    python3 "$ROOT/scripts/patch-portal-config.py" "$APP_DIR/config.json" || true
fi
if [ -f "$ROOT/scripts/validate-portal-config.py" ]; then
    python3 "$ROOT/scripts/validate-portal-config.py" "$APP_DIR/config.json"
fi

PORT="$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' config.json | head -1 | grep -o '[0-9]*')"
if [ "$PORT" = "80" ] && [ "$(id -u)" != "0" ]; then
    echo "端口 80 需要 root 权限运行"
    exit 1
fi

echo "==> 启动 portal..."
npm install -g pm2 2>/dev/null || true
pm2 delete portal 2>/dev/null || true
pm2 start src/server.js --name portal
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

sleep 1
curl -sf -o /dev/null -w "HTTP %{http_code}\n" "http://127.0.0.1:${PORT:-80}/login.html" || true

PUBLIC_IP="$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo '你的公网IP')"
echo ""
echo "部署完成。"
echo "1. 安全组放行 TCP 80"
echo "2. 浏览器打开: http://${PUBLIC_IP}/"
echo "3. 登录后在卡片进入「Torn 工具箱」，再选压价助手或公司监听"
echo "4. 确保 torn-undercut (:8790) 与 torn-company (:8791) 已通过 pm2 运行"
