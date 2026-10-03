#!/bin/bash
# 思源 workspace 离线备份；失败时恢复原先运行的容器。
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIYUAN_DIR="$ROOT/siyuan"
BACKUP_DIR="${SIYUAN_BACKUP_DIR:-/opt/backups/siyuan}"
KEEP="${SIYUAN_BACKUP_KEEP:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="${SIYUAN_BACKUP_LOG:-/var/log/siyuan-backup.log}"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || { echo 'KEEP 必须是正整数' >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
touch "$LOG" 2>/dev/null || LOG="/tmp/siyuan-backup.log"
exec >>"$LOG" 2>&1
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || { log '已有备份正在执行，本次跳过'; exit 0; }
ARCHIVE="$BACKUP_DIR/siyuan-workspace-$STAMP.tar.gz"
ENV_BAK="$BACKUP_DIR/siyuan-env-$STAMP.bak"
RESTART=0
SUCCESS=0
cleanup() {
    local status=$?
    trap - EXIT
    if [[ "$RESTART" -eq 1 ]]; then
        log '恢复思源容器...'
        if ! (cd "$SIYUAN_DIR" && docker compose start siyuan); then
            log '错误: 思源容器恢复失败，需人工检查'
            status=1
        fi
    fi
    rm -f -- "$ARCHIVE.partial" "$ENV_BAK.partial"
    if [[ "$status" -ne 0 || "$SUCCESS" -ne 1 ]]; then
        log "错误: 备份失败，退出码 $status（旧备份保留）"
        printf '%s 备份失败，查看 %s\n' "$STAMP" "$LOG" > "$BACKUP_DIR/last-failure.txt"
        logger -p user.err -t siyuan-backup "备份失败，查看 $LOG" || true
        status=1
    else
        rm -f -- "$BACKUP_DIR/last-failure.txt"
        printf '%s\n' "$STAMP" > "$BACKUP_DIR/last-success.txt"
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
log '========== 思源备份开始 =========='
[[ -d "$SIYUAN_DIR/data/siyuan" ]] || { log '错误: 未找到思源 workspace'; exit 1; }
cd "$SIYUAN_DIR"
running=$(docker compose ps --status running -q siyuan)
if [[ -n "$running" ]]; then
    # 先设置恢复标记，确保 stop 被中断时也能恢复。
    RESTART=1
    log '停止思源容器...'
    docker compose stop siyuan
fi
tar -czf "$ARCHIVE.partial" -C data siyuan
if [[ -f .env ]]; then cp -- .env "$ENV_BAK.partial"; fi
if [[ "$RESTART" -eq 1 ]]; then
    log '启动思源容器...'
    docker compose start siyuan
    RESTART=0
fi
# 恢复容器后再验证，缩短停机时间；仅发布验证通过的归档。
gzip -t "$ARCHIVE.partial"
tar -tzf "$ARCHIVE.partial" > /dev/null
mv -- "$ARCHIVE.partial" "$ARCHIVE"
if [[ -f "$ENV_BAK.partial" ]]; then mv -- "$ENV_BAK.partial" "$ENV_BAK"; fi
log "归档已校验: $ARCHIVE ($(du -h "$ARCHIVE" | awk '{print $1}'))"
prune() {
    local pattern="$1" file
    local -a files=()
    # 按时间戳文件名倒序，避免 .env 原始 mtime 干扰保留策略。
    mapfile -t files < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%f\n' | sort -r)
    for file in "${files[@]:KEEP}"; do
        rm -- "$BACKUP_DIR/$file"
        log "删除旧备份: $file"
    done
}
prune 'siyuan-workspace-*.tar.gz'
prune 'siyuan-env-*.bak'
SUCCESS=1
log "完成，保留最近 $KEEP 份"
log '========== 思源备份结束 =========='
