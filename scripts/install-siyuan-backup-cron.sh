#!/bin/bash
# 安装/更新思源每天 12:00 定时备份（ECS 时区 Asia/Shanghai）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/backup-siyuan.sh"
LOG="/var/log/siyuan-backup.log"

chmod +x "$SCRIPT"
mkdir -p /opt/backups/siyuan
touch "$LOG"

# 仅替换这个脚本的活动任务，保留其他任务、注释和环境变量。
# 使用 bash 调用，避免 checkout 后执行权限变化导致定时任务失败。
CRON_LINE="0 12 * * * /bin/bash $SCRIPT >> $LOG 2>&1"
current_cron=$(crontab -l 2>/dev/null || true)
cron_file=$(mktemp)
trap 'rm -f -- "$cron_file"' EXIT
printf '%s\n' "$current_cron" | awk -v script="$SCRIPT" '
    /^[[:space:]]*#/ { print; next }
    $6 == script || ($6 == "/bin/bash" && $7 == script) { next }
    { print }
' > "$cron_file"
printf '%s\n' "$CRON_LINE" >> "$cron_file"
crontab "$cron_file"
echo "已更新 cron: $CRON_LINE"

echo "备份目录: /opt/backups/siyuan"
echo "日志: $LOG"
echo ""
echo "立即试跑: $SCRIPT"
