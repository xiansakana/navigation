#!/bin/bash
# 清理 ECS 上调试用的 /tmp 脚本与已废弃的 navigation 脚本
set -e

echo "==> 清理 /tmp 调试脚本..."
rm -f /tmp/*.py

echo "==> 移除已废弃的 navigation 脚本..."
ROOT="${NAV_ROOT:-/opt/navigation}"
for f in \
    "$ROOT/scripts/sync-portal-external-links.py" \
    "$ROOT/scripts/patch-napcat-public-port.sh" \
    "$ROOT/scripts/sync-napcat-token.py" \
    "$ROOT/scripts/sync-siyuan-auth.py" \
    "$ROOT/scripts/grant-guest-notes-edit.py"
do
    if [ -f "$f" ]; then
        rm -f "$f"
        echo "  removed $f"
    fi
done

echo "==> 完成"
