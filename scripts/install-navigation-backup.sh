#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v python3 >/dev/null
install -d -m 700 /opt/backups/navigation
# Reuse a recently verified upload when initial recovery verification was performed separately.
# Failure leaves the existing schedule unchanged.
if [[ $# -eq 2 && "$1" == --verified-receipt ]]; then
  node --input-type=module - "$2" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const file = path.resolve(process.argv[2]);
if (path.dirname(file) !== '/opt/backups/navigation' || !/^navigation-[\d-]+\.tar\.gz\.115\.json$/.test(path.basename(file))) throw new Error('Invalid backup receipt path');
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
const age = Date.now() - Date.parse(receipt.verifiedAt);
if (receipt.state !== 'verified' || !Number.isFinite(age) || age < 0 || age > 12 * 3600000 || !receipt.parts?.length || receipt.parts.some(part => !part.verified)) throw new Error('A verified upload from the last 12 hours is required');
if (fs.readFileSync(path.join(path.dirname(file), '.encryption-key')).length !== 32) throw new Error('Invalid backup encryption key');
console.log('Reusing verified backup receipt');
JS
elif [[ $# -eq 0 ]]; then
  bash "$ROOT/scripts/backup-navigation-115.sh"
else
  echo 'Usage: install-navigation-backup.sh [--verified-receipt FILE]' >&2
  exit 1
fi
umask 077
printf '17 */12 * * * root /bin/bash "%s/scripts/backup-navigation-115.sh" >> /var/log/navigation-backup.log 2>&1 || /usr/bin/logger -p user.err -t navigation-backup "Navigation backup failed; see /var/log/navigation-backup.log"\n' "$ROOT" > /etc/cron.d/navigation-backup
chmod 600 /etc/cron.d/navigation-backup
