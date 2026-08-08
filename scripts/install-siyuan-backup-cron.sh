#!/bin/bash
# 安装思源凌晨 3 点定时备份（cron）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/backup-siyuan.sh"
LOG="/var/log/siyuan-backup.log"
CRON_LINE="0 3 * * * $SCRIPT >> $LOG 2>&1"

chmod +x "$SCRIPT"
mkdir -p /opt/backups/siyuan
touch "$LOG"

if crontab -l 2>/dev/null | grep -Fq "$SCRIPT" 2>/dev/null; then
    echo "cron 已存在，跳过: $CRON_LINE"
else
    (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    echo "已安装 cron: $CRON_LINE"
fi

echo "备份目录: /opt/backups/siyuan"
echo "日志: $LOG"
echo ""
echo "立即试跑: $SCRIPT"
