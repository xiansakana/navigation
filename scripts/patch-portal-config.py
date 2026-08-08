#!/usr/bin/env python3
"""Fix portal torn-toolbox: hub + undercut/company proxy services (local or ECS).

为何需要本脚本
--------------
portal/config.json 在 .gitignore 中，git pull 不会更新它。历史上 torn-toolbox 曾是
直连 :8790 的 proxy；迁移为 hub 后，ECS 上的旧 config 会一直保留，直到被本脚本修正。

常见复发原因
------------
1. ecs-deploy-from-local.ps1 scp 整目录，用本机旧 config.json 覆盖 ECS
2. 仅 git pull + 重启 portal，未运行本脚本
3. 从旧仓库 migrate-ecs-from-torn-scripts.sh 复制了 legacy config

ecs-update.sh 在每次 portal 更新时会自动运行本脚本。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "portal" / "config.json"


def load_json(path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def is_real_token(val):
    if not val or not isinstance(val, str):
        return False
    markers = ("相同", "换成", "change-me", "config.", "与 ", "请填")
    return not any(m in val for m in markers)


def read_token_from_file(name):
    data = load_json(ROOT / "torn-toolbox-desktop" / name, {})
    return (data.get("server") or {}).get("adminToken") or ""


cfg = load_json(CONFIG_PATH, {})
services = cfg.get("services") or []
by_id = {s["id"]: s for s in services if s.get("id")}

undercut_token = ""
company_token = ""
old_toolbox = by_id.get("torn-toolbox") or {}
if is_real_token(old_toolbox.get("adminToken")):
    undercut_token = old_toolbox["adminToken"]
if is_real_token((by_id.get("torn-undercut") or {}).get("adminToken")):
    undercut_token = by_id["torn-undercut"]["adminToken"]
if is_real_token((by_id.get("torn-company") or {}).get("adminToken")):
    company_token = by_id["torn-company"]["adminToken"]
if not is_real_token(undercut_token):
    undercut_token = read_token_from_file("config.undercut.json")
if not is_real_token(company_token):
    company_token = read_token_from_file("config.company.json")

others = [s for s in services if s.get("id") not in ("torn-toolbox", "torn-undercut", "torn-company")]

hub = {
    "id": "torn-toolbox",
    "title": "Torn 工具箱",
    "description": "压价助手与公司申请监听（独立进程）",
    "type": "hub",
    "path": "/torn-toolbox",
    "entryPath": "/",
    "icon": "📊",
}
undercut = {
    "id": "torn-undercut",
    "title": "压价助手",
    "hidden": True,
    "type": "proxy",
    "path": "/torn-toolbox/undercut",
    "entryPath": "/",
    "internalUrl": "http://127.0.0.1:8790",
    "icon": "📉",
}
company = {
    "id": "torn-company",
    "title": "公司监听",
    "hidden": True,
    "type": "proxy",
    "path": "/torn-toolbox/company",
    "entryPath": "/",
    "internalUrl": "http://127.0.0.1:8791",
    "icon": "🏢",
}
if is_real_token(undercut_token):
    undercut["adminToken"] = undercut_token
if is_real_token(company_token):
    company["adminToken"] = company_token

cfg["services"] = [hub, undercut, company] + others
CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("portal config: torn-toolbox hub + undercut + company restored ->", CONFIG_PATH)
