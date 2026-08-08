#!/usr/bin/env python3
"""将 siyuan-share 对外访问地址同步到 Share DB 的 site_base_url 与 portal config.publicUrl。"""
import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORTAL_CFG = Path(os.environ.get('PORTAL_CONFIG', str(ROOT / 'portal' / 'config.json')))
SHARE_ENV = Path(os.environ.get('SHARE_ENV', str(ROOT / 'siyuan-share' / '.env')))
SHARE_DB = Path(os.environ.get('SHARE_DB', str(ROOT / 'siyuan-share' / 'data/storage/app.db')))
DEFAULT_PUBLIC_URL = 'http://123.56.235.12/share'


def read_env(path):
    values = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, val = line.split('=', 1)
        values[key.strip()] = val.strip().strip('"').strip("'")
    return values


def sync_db(public_url):
    if not SHARE_DB.exists():
        print(f'share db not found: {SHARE_DB}', file=sys.stderr)
        return False
    conn = sqlite3.connect(str(SHARE_DB))
    row = conn.execute("SELECT value FROM settings WHERE key = 'site_base_url' LIMIT 1").fetchone()
    current = (row[0] if row else '') or ''
    if current == public_url:
        print('share site_base_url already up to date')
        conn.close()
        return False
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES ('site_base_url', ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (public_url,),
    )
    conn.commit()
    conn.close()
    print('share site_base_url synced')
    return True


def sync_portal(public_url):
    if not PORTAL_CFG.exists():
        print(f'portal config not found: {PORTAL_CFG}', file=sys.stderr)
        return False
    portal = json.loads(PORTAL_CFG.read_text(encoding='utf-8'))
    updated = False
    for svc in portal.get('services', []):
        if svc.get('id') != 'siyuan-share':
            continue
        if svc.get('publicUrl') != public_url:
            svc['publicUrl'] = public_url
            updated = True
        break
    else:
        print('siyuan-share service not found in portal config', file=sys.stderr)
        return False
    if not updated:
        print('portal share publicUrl already up to date')
        return False
    PORTAL_CFG.write_text(json.dumps(portal, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('portal share publicUrl synced')
    return True


def main():
    env = read_env(SHARE_ENV)
    public_url = (env.get('SIYUAN_SHARE_PUBLIC_URL') or DEFAULT_PUBLIC_URL).rstrip('/')
    sync_db(public_url)
    sync_portal(public_url)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
