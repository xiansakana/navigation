#!/usr/bin/env python3
"""在 portal/config.json 注册 AList 反代（:5244 → /alist/，需登录）。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "portal" / "config.json"

ALIST_PROXY = {
    "id": "alist",
    "title": "AList 网盘",
    "description": "网盘聚合（AList，经 Portal 反代，仅本机 :5244）",
    "type": "proxy",
    "path": "/alist",
    "entryPath": "/",
    "internalUrl": "http://127.0.0.1:5244",
    "upstreamPathPrefix": "/alist",
    "injectBar": False,
    "injectBase": False,
    "icon": "📁",
}


def main():
    if not CONFIG_PATH.exists():
        print("portal config not found:", CONFIG_PATH, file=sys.stderr)
        return 1
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    services = cfg.setdefault("services", [])
    changed = False
    for idx, svc in enumerate(services):
        if svc.get("id") != "alist":
            continue
        merged = dict(svc)
        merged.update(ALIST_PROXY)
        for key in ("url", "newTab", "publicAccess"):
            if key == "publicAccess" and key in merged and merged.get(key):
                merged.pop(key, None)
            elif key in ("url", "newTab"):
                merged.pop(key, None)
        if merged != svc:
            services[idx] = merged
            changed = True
        break
    else:
        insert = len(services)
        for i, svc in enumerate(services):
            if svc.get("id") in ("piclist", "siyuan-share", "napcat"):
                insert = i
                break
        services.insert(insert, dict(ALIST_PROXY))
        changed = True

    if changed:
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("portal alist proxy registered ->", CONFIG_PATH)
    else:
        print("portal alist proxy already up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
