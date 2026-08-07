#!/bin/bash
# 从 /opt/xiansakana-torn-scripts 迁移配置到 /opt/navigation（一次性）
set -e

OLD=/opt/xiansakana-torn-scripts
NEW=/opt/navigation

if [ ! -d "$NEW" ]; then
    echo "错误: $NEW 不存在，请先 clone navigation 仓库"
    exit 1
fi

echo "==> 修复脚本权限与换行..."
find "$NEW" -name '*.sh' -exec sed -i 's/\r$//' {} +
chmod +x "$NEW"/scripts/*.sh "$NEW"/portal/deploy-ecs.sh "$NEW"/qq-bot/deploy-ecs.sh "$NEW"/torn-toolbox-desktop/deploy-ecs.sh

echo "==> 复制配置文件..."
if [ -f "$OLD/portal/config.json" ] && [ ! -f "$NEW/portal/config.json" ]; then
    cp "$OLD/portal/config.json" "$NEW/portal/config.json"
    echo "  portal/config.json"
fi
if [ -f "$OLD/qq-bot/config.json" ] && [ ! -f "$NEW/qq-bot/config.json" ]; then
    cp "$OLD/qq-bot/config.json" "$NEW/qq-bot/config.json"
    echo "  qq-bot/config.json"
fi
for f in config.undercut.json config.company.json config.json; do
    if [ -f "$OLD/torn-toolbox-desktop/$f" ] && [ ! -f "$NEW/torn-toolbox-desktop/$f" ]; then
        cp "$OLD/torn-toolbox-desktop/$f" "$NEW/torn-toolbox-desktop/$f"
        echo "  torn-toolbox-desktop/$f"
    fi
done

if [ -f "$NEW/qq-bot/config.json" ] && grep -q '"host": "127.0.0.1"' "$NEW/qq-bot/config.json"; then
    sed -i 's/"host": "127.0.0.1"/"host": "0.0.0.0"/' "$NEW/qq-bot/config.json"
    echo "  qq-bot server.host -> 0.0.0.0"
fi

echo "==> 重新部署 pm2（指向新路径）..."
cd "$NEW/qq-bot" && npm install --production && ./deploy-ecs.sh
cd "$NEW/torn-toolbox-desktop" && npm install --production && ./deploy-ecs.sh
cd "$NEW/portal" && ./deploy-ecs.sh

echo "==> 完成。可选: rm -rf $OLD"
pm2 status
