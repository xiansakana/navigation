#!/usr/bin/env python3
import json

path = "/opt/navigation/portal/config.json"
with open(path, encoding="utf-8") as f:
    cfg = json.load(f)

napcat = next(s for s in cfg["services"] if s["id"] == "napcat")
cfg["services"] = [
    {
        "id": "torn-toolbox",
        "title": "Torn 工具箱",
        "description": "压价助手与公司申请监听（独立进程）",
        "type": "hub",
        "path": "/torn-toolbox",
        "entryPath": "/",
        "icon": "📊",
    },
    {
        "id": "torn-undercut",
        "title": "压价助手",
        "hidden": True,
        "type": "proxy",
        "path": "/torn-toolbox/undercut",
        "entryPath": "/",
        "internalUrl": "http://127.0.0.1:8790",
        "icon": "📉",
    },
    {
        "id": "torn-company",
        "title": "公司监听",
        "hidden": True,
        "type": "proxy",
        "path": "/torn-toolbox/company",
        "entryPath": "/",
        "internalUrl": "http://127.0.0.1:8791",
        "icon": "🏢",
    },
    napcat,
]

with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")

print("portal config updated")
