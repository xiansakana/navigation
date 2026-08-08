#!/usr/bin/env python3
"""在 portal/config.json 注册思源内置发布站反代（:6808 → /publish/，公开访问）。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "portal" / "config.json"

PUBLISH_PROXY = {
    "id": "siyuan-publish",
    "title": "笔记发布站",
    "description": "思源公开只读站点（在思源 设置→发布服务 中开启，并将笔记本设为公开）",
    "type": "proxy",
    "path": "/publish",
    "entryPath": "/",
    "internalUrl": "http://127.0.0.1:6808",
    "upstreamPathPrefix": "/publish",
    "publicAccess": True,
    "injectBar": False,
    "injectBase": False,
    "icon": "🌐",
}


def main():
    if not CONFIG_PATH.exists():
        print("portal config not found:", CONFIG_PATH, file=sys.stderr)
        return 1
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    services = cfg.setdefault("services", [])
    changed = False
    for idx, svc in enumerate(services):
        if svc.get("id") != "siyuan-publish":
            continue
        merged = dict(svc)
        merged.update(PUBLISH_PROXY)
        if merged != svc:
            services[idx] = merged
            changed = True
        break
    else:
        insert = 0
        for i, svc in enumerate(services):
            if svc.get("id") == "notes":
                insert = i + 1
                break
        services.insert(insert, dict(PUBLISH_PROXY))
        changed = True

    if changed:
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("portal siyuan-publish proxy registered ->", CONFIG_PATH)
    else:
        print("portal siyuan-publish proxy already up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
