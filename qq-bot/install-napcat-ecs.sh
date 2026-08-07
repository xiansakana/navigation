#!/bin/bash
# ECS 安装 Docker + NapCat（在任意目录执行，会创建 /opt/napcat）
set -e

echo "==> 安装 Docker..."
if ! command -v docker >/dev/null 2>&1; then
    if [ -f /etc/alinux-release ] || [ -f /etc/centos-release ] || [ -f /etc/redhat-release ]; then
        yum install -y yum-utils
        yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo || true
        yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    else
        apt-get update
        apt-get install -y docker.io docker-compose-plugin
    fi
fi

systemctl enable docker
systemctl start docker

mkdir -p /opt/napcat/config /opt/napcat/ntqq
cd /opt/napcat

if [ ! -f docker-compose.yml ]; then
    cat > docker-compose.yml << 'EOF'
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: always
    environment:
      - NAPCAT_UID=0
      - NAPCAT_GID=0
    ports:
      - "127.0.0.1:3000:3000"
      - "127.0.0.1:3001:3001"
      - "127.0.0.1:6099:6099"
    volumes:
      - ./config:/app/napcat/config
      - ./ntqq:/app/.config/QQ
EOF
fi

echo "==> 拉取并启动 NapCat..."
docker compose pull
docker compose up -d

echo ""
echo "NapCat 已启动。下一步："
echo "  1. 阿里云安全组放行 6099（仅你的 IP 更好）"
echo "  2. 浏览器打开: http://$(curl -s --connect-timeout 2 ifconfig.me || echo '123.56.235.12'):6099/webui"
echo "  3. 扫码登录 QQ → 网络配置 → 启用 HTTP 端口 3000，复制 HTTP Token"
echo "  4. 编辑 /opt/qq-bot/config.json 填入 accessToken，server.host 改为 0.0.0.0"
echo "  5. cd /opt/qq-bot && bash deploy-ecs.sh"
echo ""
echo "查看登录二维码/日志: docker logs -f napcat"
