#!/usr/bin/env python3
import json
import secrets
from pathlib import Path

ROOT = Path('/opt/xiansakana-torn-scripts')
torn_cfg_path = ROOT / 'torn-toolbox-desktop/config.json'
portal_cfg_path = ROOT / 'portal/config.json'
example_path = ROOT / 'portal/config.ecs.example.json'
webui_cfg_path = Path('/opt/napcat/config/webui.json')

torn_cfg = json.loads(torn_cfg_path.read_text(encoding='utf-8'))
login_password = torn_cfg.get('server', {}).get('adminToken') or 'Kimiga1bansuki'

if torn_cfg.get('server', {}).get('host') != '127.0.0.1':
    torn_cfg.setdefault('server', {})['host'] = '127.0.0.1'
    torn_cfg['server']['openBrowser'] = False
    torn_cfg_path.write_text(json.dumps(torn_cfg, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('updated torn-toolbox host -> 127.0.0.1')

napcat_token = ''
if webui_cfg_path.exists():
    napcat_token = json.loads(webui_cfg_path.read_text(encoding='utf-8')).get('token', '')

portal = json.loads(example_path.read_text(encoding='utf-8'))
if portal_cfg_path.exists():
    old = json.loads(portal_cfg_path.read_text(encoding='utf-8'))
    portal['auth'] = old.get('auth', portal['auth'])

portal['auth']['username'] = 'admin'
portal['auth']['password'] = login_password
if not portal.get('auth', {}).get('sessionSecret'):
    portal['auth']['sessionSecret'] = secrets.token_hex(24)

for svc in portal.get('services', []):
    if svc.get('id') == 'torn-toolbox':
        svc.pop('adminToken', None)
    if svc.get('id') == 'napcat' and napcat_token:
        svc['adminToken'] = napcat_token

portal_cfg_path.write_text(json.dumps(portal, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print('portal config written (from ecs example template)')
print('login user:', portal['auth']['username'])
print('login pass:', portal['auth']['password'])
