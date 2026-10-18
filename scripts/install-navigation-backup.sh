#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v python3 >/dev/null
install -d -m 700 /opt/backups/navigation
# Run and verify a real backup before installing the schedule. Failure leaves cron unchanged.
bash "$ROOT/scripts/backup-navigation-115.sh"
umask 077
printf '17 */12 * * * root /bin/bash "%s/scripts/backup-navigation-115.sh" >> /var/log/navigation-backup.log 2>&1 || /usr/bin/logger -p user.err -t navigation-backup "Navigation backup failed; see /var/log/navigation-backup.log"\n' "$ROOT" > /etc/cron.d/navigation-backup
chmod 600 /etc/cron.d/navigation-backup
