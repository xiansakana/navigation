#!/usr/bin/env python3
"""Add or update siyuan-share external link in portal config.json."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "portal" / "config.json"
PUBLIC_URL = sys.argv[2].rstrip('/') if len(sys.argv) > 2 else 'http://123.56.235.12:6807'

SHARE_SERVICE = {
    "id": "siyuan-share",
    "title": "笔记分享",
    "description": "思源笔记公开分享与 API Key 管理",
    "type": "external",
    "url": PUBLIC_URL + "/dashboard",
    "newTab": True,
    "icon": "🔗",
}


def main():
    if not CONFIG_PATH.exists():
        print(f"skip: {CONFIG_PATH} not found")
        return
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    services = cfg.get("services") or []
    updated = False
    for s in services:
        if s.get("id") == "siyuan-share":
            s.clear()
            s.update(SHARE_SERVICE)
            s.pop("hidden", None)
            updated = True
            break
    if not updated:
        insert_at = len(services)
        for i, s in enumerate(services):
            if s.get("id") == "napcat":
                insert_at = i
                break
        services.insert(insert_at, dict(SHARE_SERVICE))
    cfg["services"] = services
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"patched {CONFIG_PATH}")


if __name__ == "__main__":
    main()
