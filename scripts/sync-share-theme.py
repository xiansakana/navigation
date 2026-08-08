#!/usr/bin/env python3
"""将 share-theme-portal.css 同步到 Share DB 的 site_custom_css。"""
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THEME = Path(os.environ.get('SHARE_THEME_CSS', str(ROOT / 'siyuan-share' / 'share-theme-portal.css')))
SHARE_DB = Path(os.environ.get('SHARE_DB', str(ROOT / 'siyuan-share' / 'data/storage/app.db')))


def main():
    if not THEME.exists():
        print(f'theme css not found: {THEME}', file=sys.stderr)
        return 1
    if not SHARE_DB.exists():
        print(f'share db not found: {SHARE_DB}', file=sys.stderr)
        return 1
    css = THEME.read_text(encoding='utf-8').strip()
    if not css:
        print('theme css is empty', file=sys.stderr)
        return 1
    conn = sqlite3.connect(str(SHARE_DB))
    row = conn.execute("SELECT value FROM settings WHERE key = 'site_custom_css' LIMIT 1").fetchone()
    current = (row[0] if row else '') or ''
    if current == css:
        print('site_custom_css already up to date')
    else:
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('site_custom_css', ?, datetime('now')) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (css,),
        )
        conn.commit()
        print('site_custom_css synced from', THEME.name)
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES ('site_custom_css_enabled', '1', datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at",
    )
    conn.commit()
    conn.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
