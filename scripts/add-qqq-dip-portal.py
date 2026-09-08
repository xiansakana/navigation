#!/usr/bin/env python3
import json
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "portal" / "config.json"
cfg = json.loads(path.read_text(encoding="utf-8"))
services = cfg.get("services", [])
if any(s.get("id") == "qqq-dip" for s in services):
    print("qqq-dip already in portal config")
    raise SystemExit(0)

entry = {
    "id": "qqq-dip",
    "title": "抄底监控",
    "hidden": True,
    "type": "proxy",
    "path": "/stock-manage/dip",
    "entryPath": "/",
    "internalUrl": "http://127.0.0.1:5001",
    "injectBar": True,
    "injectBase": False,
    "icon": "📉",
}
idx = next((i for i, s in enumerate(services) if s.get("id") == "stock-manage"), None)
if idx is None:
    services.append(entry)
else:
    services.insert(idx + 1, entry)
cfg["services"] = services
path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("added qqq-dip to portal config")
