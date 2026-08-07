#!/usr/bin/env python3
import json
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "portal" / "config.json"
cfg = json.loads(path.read_text(encoding="utf-8"))
for svc in cfg.get("services", []):
    if svc.get("id") == "stock-manage":
        svc["injectBase"] = False
        svc["injectBar"] = True
        print("stock-manage: injectBase=false, injectBar=true")
        break
else:
    raise SystemExit("stock-manage service not found")
path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
