#!/usr/bin/env python3
"""将 NapCat webui.json 中的 token 同步到 portal config.json 的 napcat.adminToken。"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORTAL_CFG = Path(os.environ.get('PORTAL_CONFIG', str(ROOT / 'portal' / 'config.json')))
WEBUI_CFG = Path(os.environ.get('NAPCAT_WEBUI_CONFIG', '/opt/napcat/config/webui.json'))


def main():
    if not PORTAL_CFG.exists():
        print(f'portal config not found: {PORTAL_CFG}', file=sys.stderr)
        return 1
    if not WEBUI_CFG.exists():
        print(f'napcat webui config not found: {WEBUI_CFG}', file=sys.stderr)
        return 1

    token = json.loads(WEBUI_CFG.read_text(encoding='utf-8')).get('token', '')
    if not token:
        print('webui.json has no token, skip', file=sys.stderr)
        return 1

    portal = json.loads(PORTAL_CFG.read_text(encoding='utf-8'))
    updated = False
    for svc in portal.get('services', []):
        if svc.get('id') == 'napcat':
            if svc.get('adminToken') != token:
                svc['adminToken'] = token
                updated = True
            break
    else:
        print('napcat service not found in portal config', file=sys.stderr)
        return 1

    if not updated:
        print('napcat adminToken already up to date')
        return 0

    PORTAL_CFG.write_text(json.dumps(portal, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('napcat adminToken synced from webui.json')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
