#!/usr/bin/env python3
import json
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "portal" / "config.json"
cfg = json.loads(path.read_text(encoding="utf-8"))
services = cfg.get("services", [])
if any(s.get("id") == "stock-manage" for s in services):
    print("stock-manage already in portal config")
    raise SystemExit(0)

entry = {
    "id": "stock-manage",
    "title": "股票管理",
    "description": "美股持仓、交易记录与盈亏统计（服务端持久化）",
    "type": "proxy",
    "path": "/stock-manage",
    "entryPath": "/",
        "internalUrl": "http://127.0.0.1:5000",
        "injectBar": True,
        "injectBase": False,
        "icon": "📈",
}
idx = next((i for i, s in enumerate(services) if s.get("id") == "napcat"), len(services))
services.insert(idx, entry)
cfg["services"] = services
path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("added stock-manage to portal config")
