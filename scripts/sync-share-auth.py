#!/usr/bin/env python3
"""将 siyuan-share/.env 中的 SSO 凭据同步到 portal config.json 的 siyuan-share 服务。"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORTAL_CFG = Path(os.environ.get('PORTAL_CONFIG', str(ROOT / 'portal' / 'config.json')))
SHARE_ENV = Path(os.environ.get('SHARE_ENV', str(ROOT / 'siyuan-share' / '.env')))


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


def main():
    if not PORTAL_CFG.exists():
        print(f'portal config not found: {PORTAL_CFG}', file=sys.stderr)
        return 1

    env = read_env(SHARE_ENV)
    portal = json.loads(PORTAL_CFG.read_text(encoding='utf-8'))
    portal_auth = portal.get('auth') or {}

    username = env.get('SHARE_SSO_USERNAME') or portal_auth.get('username') or 'admin'
    password = env.get('SHARE_SSO_PASSWORD') or portal_auth.get('password') or ''
    if not password:
        print('no SHARE_SSO_PASSWORD in .env and no portal auth password', file=sys.stderr)
        return 1

    updated = False
    for svc in portal.get('services', []):
        if svc.get('id') == 'siyuan-share':
            if svc.get('shareUsername') != username:
                svc['shareUsername'] = username
                updated = True
            if svc.get('sharePassword') != password:
                svc['sharePassword'] = password
                updated = True
            break
    else:
        print('siyuan-share service not found in portal config', file=sys.stderr)
        return 1

    if not updated:
        print('siyuan-share SSO credentials already up to date')
        return 0

    PORTAL_CFG.write_text(json.dumps(portal, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('siyuan-share SSO credentials synced from siyuan-share/.env')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
