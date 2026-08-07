#!/usr/bin/env python3
"""在 portal/config.json 中注册 notes 服务（若尚未存在）。"""
import json
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "portal" / "config.json"
if not path.exists():
    print("portal/config.json 不存在，跳过")
    raise SystemExit(0)

cfg = json.loads(path.read_text(encoding="utf-8"))
services = cfg.setdefault("services", [])
if any(s.get("id") == "notes" for s in services):
    print("notes 已注册")
    raise SystemExit(0)

entry = {
    "id": "notes",
    "title": "笔记",
    "description": "块级富文本笔记，笔记本与文档管理",
    "type": "proxy",
    "path": "/notes",
    "entryPath": "/",
    "internalUrl": "http://127.0.0.1:5001",
    "injectBar": True,
    "injectBase": False,
    "icon": "📝",
}

idx = next((i for i, s in enumerate(services) if s.get("id") == "stock-manage"), len(services))
services.insert(idx + 1, entry)
path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("portal config: notes 已添加")
