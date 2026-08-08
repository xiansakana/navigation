#!/bin/bash
# 思源笔记 workspace 离线备份（停容器 → tar → 启动）
# 定时: 0 3 * * * /opt/navigation/scripts/backup-siyuan.sh >> /var/log/siyuan-backup.log 2>&1
# 或运行: ./scripts/install-siyuan-backup-cron.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIYUAN_DIR="$ROOT/siyuan"
BACKUP_DIR="${SIYUAN_BACKUP_DIR:-/opt/backups/siyuan}"
KEEP="${SIYUAN_BACKUP_KEEP:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="${SIYUAN_BACKUP_LOG:-/var/log/siyuan-backup.log}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

mkdir -p "$BACKUP_DIR"
touch "$LOG" 2>/dev/null || LOG="/tmp/siyuan-backup.log"

exec >>"$LOG" 2>&1

log "========== 思源备份开始 =========="

if [[ ! -d "$SIYUAN_DIR/data/siyuan" ]]; then
    log "错误: 未找到 $SIYUAN_DIR/data/siyuan"
    exit 1
fi

ARCHIVE="$BACKUP_DIR/siyuan-workspace-$STAMP.tar.gz"
ENV_BAK="$BACKUP_DIR/siyuan-env-$STAMP.bak"

log "目标: $ARCHIVE"

cd "$SIYUAN_DIR"
RESTART=0
if docker compose ps -q siyuan 2>/dev/null | grep -q .; then
    log "停止思源容器..."
    docker compose stop
    RESTART=1
fi

tar -czf "$ARCHIVE" -C data siyuan
log "workspace 已打包 ($(du -h "$ARCHIVE" | awk '{print $1}'))"

if [[ -f .env ]]; then
    cp -a .env "$ENV_BAK"
    chmod 600 "$ENV_BAK"
    log "已备份 .env"
fi

if [[ "$RESTART" -eq 1 ]]; then
    log "启动思源容器..."
    docker compose start
fi

prune() {
    local pattern="$1"
    local files
    mapfile -t files < <(ls -t $pattern 2>/dev/null || true)
    if [[ ${#files[@]} -gt "$KEEP" ]]; then
        for ((i = KEEP; i < ${#files[@]}; i++)); do
            rm -f "${files[$i]}"
            log "删除旧备份: ${files[$i]}"
        done
    fi
}

prune "$BACKUP_DIR/siyuan-workspace-"*.tar.gz
prune "$BACKUP_DIR/siyuan-env-"*.bak

log "完成，保留最近 $KEEP 份"
log "========== 思源备份结束 =========="
