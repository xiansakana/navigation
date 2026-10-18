#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESTINATION="${NAVIGATION_BACKUP_DIR:-/opt/backups/navigation}"
install -d -m 700 "$DESTINATION"
exec 9>"$DESTINATION/.115-backup.lock"
flock -n 9 || exit 0
# Retry pending archives first. A failed upload never deletes the only local copy.
shopt -s nullglob
pending=("$DESTINATION"/navigation-*.tar.gz)
if ((${#pending[@]})); then
  for archive in "${pending[@]}"; do node "$ROOT/scripts/backup-115.mjs" upload "$archive"; done
fi
archive="$(python3 "$ROOT/scripts/backup-navigation.py" --destination "$DESTINATION" --keep 3 --logical)"
node "$ROOT/scripts/backup-115.mjs" upload "$archive"
