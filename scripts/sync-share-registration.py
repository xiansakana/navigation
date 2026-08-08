#!/usr/bin/env python3
"""关闭/开启思源分享公开注册（写入 DB settings + config.php）。"""
import os
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARE_ENV = Path(os.environ.get('SHARE_ENV', str(ROOT / 'siyuan-share' / '.env')))
SHARE_DB = Path(os.environ.get('SHARE_DB', str(ROOT / 'siyuan-share' / 'data/storage/app.db')))
SHARE_CFG = Path(os.environ.get('SHARE_CONFIG', str(ROOT / 'siyuan-share' / 'config.php')))


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


def desired_allow_registration(env):
    raw = env.get('SIYUAN_SHARE_ALLOW_REGISTRATION', '0').strip().lower()
    return raw in ('1', 'true', 'yes', 'on')


def sync_db(allow):
    if not SHARE_DB.exists():
        print(f'share db not found: {SHARE_DB}', file=sys.stderr)
        return False
    value = '1' if allow else '0'
    conn = sqlite3.connect(str(SHARE_DB))
    row = conn.execute("SELECT value FROM settings WHERE key = 'allow_registration' LIMIT 1").fetchone()
    current = (row[0] if row else '') or ''
    if current == value:
        print(f'allow_registration already {value}')
    else:
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('allow_registration', ?, datetime('now')) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (value,),
        )
        conn.commit()
        print(f'allow_registration set to {value}')
    conn.close()
    return True


def sync_config_php(allow):
    if not SHARE_CFG.exists():
        print(f'skip config.php (not found): {SHARE_CFG}')
        return False
    text = SHARE_CFG.read_text(encoding='utf-8')
    replacement = f"'allow_registration' => {'true' if allow else 'false'}"
    new_text, count = re.subn(
        r"'allow_registration'\s*=>\s*(true|false)",
        replacement,
        text,
        count=1,
    )
    if count:
        SHARE_CFG.write_text(new_text, encoding='utf-8')
        print('config.php allow_registration updated')
    else:
        print('config.php allow_registration key not found', file=sys.stderr)
    return count > 0


def main():
    env = read_env(SHARE_ENV)
    allow = desired_allow_registration(env)
    sync_db(allow)
    sync_config_php(allow)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
