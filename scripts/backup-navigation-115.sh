#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESTINATION="${NAVIGATION_BACKUP_DIR:-/opt/backups/navigation}"
PYTHON="${NAVIGATION_BACKUP_PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  for candidate in python3.11 python3.10 python3.9 python3.8 python3; do
    if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys;sys.exit(0 if sys.version_info >= (3,8) else 1)'; then PYTHON="$candidate"; break; fi
  done
fi
[[ -n "$PYTHON" ]] || { echo 'Python >=3.8 is required for backups' >&2; exit 1; }
install -d -m 700 "$DESTINATION"
exec 9>"$DESTINATION/.115-backup.lock"
flock -n 9 || exit 0
# Retry pending archives first. A failed upload never deletes the only local copy.
shopt -s nullglob
pending=("$DESTINATION"/navigation-*.tar.gz)
if ((${#pending[@]})); then
  for archive in "${pending[@]}"; do node "$ROOT/scripts/backup-115.mjs" upload "$archive"; done
  # Completing a retry is this run's backup; avoid immediately exporting another large archive.
  exit 0
fi
archive="$("$PYTHON" "$ROOT/scripts/backup-navigation.py" --destination "$DESTINATION" --keep 3 --logical)"
node "$ROOT/scripts/backup-115.mjs" upload "$archive"
