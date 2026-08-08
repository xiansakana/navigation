#!/usr/bin/env python3
"""Clear Share site_custom_css and disable custom CSS (restore default theme)."""
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARE_DB = Path(os.environ.get('SHARE_DB', str(ROOT / 'siyuan-share' / 'data/storage/app.db')))


def main():
    if not SHARE_DB.exists():
        print(f'share db not found: {SHARE_DB}', file=sys.stderr)
        return 1
    conn = sqlite3.connect(str(SHARE_DB))
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES ('site_custom_css', '', datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = '', updated_at = excluded.updated_at",
    )
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES ('site_custom_css_enabled', '0', datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = excluded.updated_at",
    )
    conn.commit()
    conn.close()
    print('share custom CSS cleared; default theme restored')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
