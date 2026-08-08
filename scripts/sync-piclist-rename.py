#!/usr/bin/env python3
"""为 PicList 服务端启用时间戳自动重命名。"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CFG_PATH = ROOT / "piclist" / "data" / "config.json"

# autoRename=true -> YYYYMMDDHHmmssSSS.ext
# 若需自定义格式，可设 PICLIST_RENAME_FORMAT 并关闭 autoRename（见 buildIn.rename）
AUTO_RENAME = os.environ.get("PICLIST_AUTO_RENAME", "1") not in ("0", "false", "False")
RENAME_FORMAT = os.environ.get("PICLIST_RENAME_FORMAT", "")


def main():
    if not CFG_PATH.exists():
        print("跳过：未找到", CFG_PATH)
        return

    cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    settings = cfg.setdefault("settings", {})
    build_in = cfg.setdefault("buildIn", {})

    if RENAME_FORMAT:
        settings["autoRename"] = False
        settings["rename"] = False
        build_in["rename"] = {"enable": True, "format": RENAME_FORMAT}
        print("已启用高级重命名:", RENAME_FORMAT)
    else:
        settings["autoRename"] = AUTO_RENAME
        settings["rename"] = False
        build_in.pop("rename", None)
        print("已启用自动时间戳命名:", AUTO_RENAME)

    CFG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("已更新", CFG_PATH)


if __name__ == "__main__":
    main()
