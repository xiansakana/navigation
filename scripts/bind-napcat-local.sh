#!/bin/bash
# 将 NapCat WebUI 改为仅本机，由 portal :80 转发
set -e
cd /opt/napcat
if grep -q '"6099:6099"' docker-compose.yml 2>/dev/null; then
    sed -i 's/"6099:6099"/"127.0.0.1:6099:6099"/' docker-compose.yml
    sed -i 's/0.0.0.0:6099:6099/127.0.0.1:6099:6099/' docker-compose.yml
    docker compose up -d
    echo "NapCat 6099 已改为 127.0.0.1"
fi
