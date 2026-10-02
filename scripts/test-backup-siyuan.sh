#!/bin/bash
# 使用临时 workspace 和模拟 Docker 验证备份；不会停止真实服务。
set -euo pipefail
SOURCE="$(cd "$(dirname "$0")" && pwd)/backup-siyuan.sh"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/repo/scripts" "$TEST_ROOT/repo/siyuan/data/siyuan" "$TEST_ROOT/bin" "$TEST_ROOT/backups"
cp "$SOURCE" "$TEST_ROOT/repo/scripts/backup-siyuan.sh"
printf 'sample note\n' > "$TEST_ROOT/repo/siyuan/data/siyuan/note.txt"
printf 'test-only\n' > "$TEST_ROOT/repo/siyuan/.env"
export SIYUAN_BACKUP_DIR="$TEST_ROOT/backups" SIYUAN_BACKUP_LOG="$TEST_ROOT/log" SIYUAN_BACKUP_KEEP=2
export MOCK_DOCKER_LOG="$TEST_ROOT/docker.log"
export MOCK_STOP_FAIL=0 MOCK_TAR_FAIL=0
export REAL_TAR
REAL_TAR=$(command -v tar)
cat > "$TEST_ROOT/bin/docker" <<'MOCK'
#!/bin/bash
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
case "$2" in
    ps) echo test-container ;;
    stop) exit "$MOCK_STOP_FAIL" ;;
esac
MOCK
cat > "$TEST_ROOT/bin/tar" <<'MOCK'
#!/bin/bash
if [[ "$MOCK_TAR_FAIL" -eq 1 ]]; then exit 42; fi
exec "$REAL_TAR" "$@"
MOCK
cat > "$TEST_ROOT/bin/logger" <<'MOCK'
#!/bin/bash
exit 0
MOCK
chmod +x "$TEST_ROOT/bin/"*
export PATH="$TEST_ROOT/bin:$PATH"
RUN="$TEST_ROOT/repo/scripts/backup-siyuan.sh"
for day in 01 02 03; do
    touch "$SIYUAN_BACKUP_DIR/siyuan-workspace-202001$day-030000.tar.gz"
    touch "$SIYUAN_BACKUP_DIR/siyuan-env-202001$day-030000.bak"
done
bash "$RUN"
[[ $(find "$SIYUAN_BACKUP_DIR" -name '*.tar.gz' | wc -l) -eq 2 ]]
[[ $(find "$SIYUAN_BACKUP_DIR" -name '*.bak' | wc -l) -eq 2 ]]
[[ -f "$SIYUAN_BACKUP_DIR/last-success.txt" ]]
[[ -f "$SIYUAN_BACKUP_DIR/siyuan-workspace-20200103-030000.tar.gz" ]]
grep -q 'compose start siyuan' "$MOCK_DOCKER_LOG"
latest=$(find "$SIYUAN_BACKUP_DIR" -name '*.tar.gz' | sort -r | head -1)
[[ $(stat -c %a "$latest") == 600 ]]
"$REAL_TAR" -xOzf "$latest" siyuan/note.txt | grep -q 'sample note'
echo 'PASS: successful backup, restore content, permissions and retention'

# 使用不同时间戳，避免影响同秒内的前一份归档。
sleep 1
: > "$MOCK_DOCKER_LOG"
export MOCK_TAR_FAIL=1
if bash "$RUN"; then echo 'Expected failure' >&2; exit 1; fi
grep -q 'compose start siyuan' "$MOCK_DOCKER_LOG"
[[ -f "$SIYUAN_BACKUP_DIR/last-failure.txt" ]]
[[ $(find "$SIYUAN_BACKUP_DIR" -name '*.tar.gz' | wc -l) -eq 2 ]]
[[ $(find "$SIYUAN_BACKUP_DIR" -name '*.partial' | wc -l) -eq 0 ]]
echo 'PASS: packing failure restores container and preserves old backups'

: > "$MOCK_DOCKER_LOG"
export MOCK_TAR_FAIL=0 MOCK_STOP_FAIL=1
if bash "$RUN"; then echo 'Expected stop failure' >&2; exit 1; fi
grep -q 'compose start siyuan' "$MOCK_DOCKER_LOG"
echo 'PASS: failed stop still attempts recovery'

: > "$MOCK_DOCKER_LOG"
(
    flock -n 9
    bash "$RUN"
) 9>"$SIYUAN_BACKUP_DIR/.backup.lock"
[[ ! -s "$MOCK_DOCKER_LOG" ]]
echo 'PASS: overlapping backup does not stop container'
