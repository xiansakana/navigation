#!/usr/bin/env python3
"""Reset Share admin password in app.db (uses PHP password_hash via docker)."""
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = Path(os.environ.get('SHARE_DB', str(ROOT / 'siyuan-share' / 'data/storage/app.db')))
CONTAINER = os.environ.get('SHARE_CONTAINER', 'siyuan-share-web')
USERNAME = os.environ.get('SHARE_ADMIN_USER', 'admin')
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else 'Kimiga1bansuki'


def hash_password(raw: str) -> str:
    cmd = [
        'docker', 'exec', CONTAINER, 'php', '-r',
        f'echo password_hash({raw!r}, PASSWORD_DEFAULT);',
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, universal_newlines=True).strip()
        if out.startswith('$'):
            return out
    except (subprocess.CalledProcessError, FileNotFoundError, ImportError):
        pass
    try:
        import bcrypt
        return bcrypt.hashpw(raw.encode(), bcrypt.gensalt()).decode()
    except ImportError:
        print('need docker php or bcrypt to hash password', file=sys.stderr)
        raise SystemExit(1)


def main():
    if not DB.exists():
        print(f'db not found: {DB}', file=sys.stderr)
        return 1
    pwd_hash = hash_password(PASSWORD)
    conn = sqlite3.connect(str(DB))
    cur = conn.execute(
        'UPDATE users SET password_hash = ?, updated_at = datetime(\'now\'), must_change_password = 0 '
        'WHERE username = ?',
        (pwd_hash, USERNAME),
    )
    conn.commit()
    if cur.rowcount == 0:
        print(f'user not found: {USERNAME}', file=sys.stderr)
        return 1
    print(f'share admin ({USERNAME}) password updated')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
