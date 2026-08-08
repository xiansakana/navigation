#!/usr/bin/env python3
"""同步思源、NapCat 为 Portal 反代（仅登录且有权限的用户可访问，端口不对外暴露）。"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORTAL_CFG = Path(os.environ.get("PORTAL_CONFIG", str(ROOT / "portal" / "config.json")))
SIYUAN_ENV = Path(os.environ.get("SIYUAN_ENV", str(ROOT / "siyuan" / ".env")))
WEBUI_CFG = Path(os.environ.get("NAPCAT_WEBUI_CONFIG", "/opt/napcat/config/webui.json"))

EXTERNAL_ONLY_KEYS = ("url", "newTab")

NOTES_PROXY = {
    "id": "notes",
    "title": "笔记",
    "description": "思源笔记（SiYuan）— 块级引用、大纲、反链",
    "type": "proxy",
    "path": "/notes",
    "entryPath": "/",
    "internalUrl": "http://127.0.0.1:6806",
    "injectBar": False,
    "injectBase": False,
    "icon": "📝",
}

NAPCAT_PROXY = {
    "id": "napcat",
    "title": "NapCat 管理",
    "description": "QQ 机器人 WebUI（网络配置、登录状态）",
    "type": "proxy",
    "path": "/napcat",
    "entryPath": "/webui",
    "internalUrl": "http://127.0.0.1:6099",
    "injectBar": False,
    "injectBase": False,
    "icon": "💬",
}


def read_auth_code(path):
    if not path.exists():
        return ""
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^SIYUAN_ACCESS_AUTH_CODE=(.*)$", line)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return ""


def read_napcat_token():
    if not WEBUI_CFG.exists():
        return ""
    try:
        return json.loads(WEBUI_CFG.read_text(encoding="utf-8")).get("token", "") or ""
    except (json.JSONDecodeError, OSError):
        return ""


def to_proxy(existing, template, extras=None):
    merged = dict(existing)
    merged.update(template)
    if extras:
        merged.update(extras)
    for key in EXTERNAL_ONLY_KEYS:
        merged.pop(key, None)
    return merged


def sync_service(services, service_id, template, extras=None):
    for idx, svc in enumerate(services):
        if svc.get("id") != service_id:
            continue
        merged = to_proxy(svc, template, extras)
        if merged != svc:
            services[idx] = merged
            print("portal {} -> proxy {}".format(service_id, merged.get("path")))
            return True
        print("portal {} proxy already up to date".format(service_id))
        return False
    merged = to_proxy({}, template, extras)
    services.append(merged)
    print("portal {} added as proxy {}".format(service_id, merged.get("path")))
    return True


def main():
    if not PORTAL_CFG.exists():
        print("portal config not found:", PORTAL_CFG, file=sys.stderr)
        return 1

    auth_code = read_auth_code(SIYUAN_ENV)
    napcat_token = read_napcat_token()
    notes_extras = {"accessAuthCode": auth_code} if auth_code else {}
    napcat_extras = {"adminToken": napcat_token} if napcat_token else {}

    portal = json.loads(PORTAL_CFG.read_text(encoding="utf-8"))
    services = portal.setdefault("services", [])
    changed = False
    changed |= sync_service(services, "notes", NOTES_PROXY, notes_extras)
    changed |= sync_service(services, "napcat", NAPCAT_PROXY, napcat_extras)

    if changed:
        PORTAL_CFG.write_text(json.dumps(portal, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("portal config saved:", PORTAL_CFG)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
