#!/usr/bin/env python3
"""将 siyuan/.env 中的 SIYUAN_ACCESS_AUTH_CODE 同步到 portal config.json 的 notes.accessAuthCode。"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORTAL_CFG = Path(os.environ.get('PORTAL_CONFIG', str(ROOT / 'portal' / 'config.json')))
SIYUAN_ENV = Path(os.environ.get('SIYUAN_ENV', str(ROOT / 'siyuan' / '.env')))


def read_auth_code(path):
    if not path.exists():
        return ''
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = re.match(r'^SIYUAN_ACCESS_AUTH_CODE=(.*)$', line)
        if m:
            val = m.group(1).strip().strip('"').strip("'")
            return val
    return ''


def main():
    if not PORTAL_CFG.exists():
        print(f'portal config not found: {PORTAL_CFG}', file=sys.stderr)
        return 1

    code = read_auth_code(SIYUAN_ENV)
    if not code:
        print(f'no SIYUAN_ACCESS_AUTH_CODE in {SIYUAN_ENV}', file=sys.stderr)
        return 1

    portal = json.loads(PORTAL_CFG.read_text(encoding='utf-8'))
    updated = False
    for svc in portal.get('services', []):
        if svc.get('id') == 'notes':
            if svc.get('accessAuthCode') != code:
                svc['accessAuthCode'] = code
                updated = True
            break
    else:
        print('notes service not found in portal config', file=sys.stderr)
        return 1

    if not updated:
        print('notes accessAuthCode already up to date')
        return 0

    PORTAL_CFG.write_text(json.dumps(portal, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('notes accessAuthCode synced from siyuan/.env')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
