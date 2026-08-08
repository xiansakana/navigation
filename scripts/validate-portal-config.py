#!/usr/bin/env python3
"""校验 portal/config.json 关键结构（torn-toolbox 必须为 hub，子服务为 hidden proxy）。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "portal" / "config.json"


def validate(cfg):
    errors = []
    by_id = {s.get("id"): s for s in cfg.get("services") or [] if s.get("id")}

    hub = by_id.get("torn-toolbox")
    if not hub:
        errors.append("缺少 services[].id=torn-toolbox")
    else:
        if hub.get("type") != "hub":
            errors.append(
                "torn-toolbox 必须是 type=hub（当前 type=%s）；"
                "若为 proxy 且指向 :8790，首页会误显示为压价助手"
                % hub.get("type")
            )
        if hub.get("internalUrl"):
            errors.append("torn-toolbox hub 不应有 internalUrl（当前 %s）" % hub.get("internalUrl"))
        if hub.get("title") != "Torn 工具箱":
            errors.append("torn-toolbox 标题应为「Torn 工具箱」（当前 %s）" % hub.get("title"))

    for sid, path, port in (
        ("torn-undercut", "/torn-toolbox/undercut", "8790"),
        ("torn-company", "/torn-toolbox/company", "8791"),
    ):
        svc = by_id.get(sid)
        if not svc:
            errors.append("缺少 %s" % sid)
            continue
        if svc.get("type") != "proxy":
            errors.append("%s 必须是 type=proxy" % sid)
        if not svc.get("hidden"):
            errors.append("%s 必须 hidden=true（不应出现在首页菜单）" % sid)
        if svc.get("path") != path:
            errors.append("%s path 应为 %s" % (sid, path))
        internal = svc.get("internalUrl") or ""
        if port not in internal:
            errors.append("%s internalUrl 应指向 :%s（当前 %s）" % (sid, port, internal))

    return errors


def main():
    if not CONFIG_PATH.exists():
        print("validate-portal-config: 跳过（无 config）", CONFIG_PATH)
        return 0
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    errors = validate(cfg)
    if errors:
        print("portal config 校验失败:", CONFIG_PATH, file=sys.stderr)
        for err in errors:
            print("  -", err, file=sys.stderr)
        print("修复: python3 scripts/patch-portal-config.py", CONFIG_PATH, file=sys.stderr)
        return 1
    print("portal config OK:", CONFIG_PATH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
