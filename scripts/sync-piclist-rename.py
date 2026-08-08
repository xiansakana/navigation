#!/usr/bin/env python3
"""为 PicList 服务端启用 YYYYMMDDHHmmssSSS 时间戳重命名。"""
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PICLIST_DIR = ROOT / "piclist"
CFG_PATH = PICLIST_DIR / "data" / "config.json"
PLUGIN_SRC = PICLIST_DIR / "plugins" / "picgo-plugin-datetime-rename"
PLUGIN_NAME = "picgo-plugin-datetime-rename"
PLUGIN_DST = PICLIST_DIR / "data" / "node_modules" / PLUGIN_NAME

AUTO_RENAME = os.environ.get("PICLIST_AUTO_RENAME", "1") not in ("0", "false", "False")
OLD_PLUGINS = ("picgo-plugin-rename", "picgo-plugin-rename-file")


def install_local_plugin():
    if not PLUGIN_SRC.is_dir():
        raise SystemExit("缺少插件源码: {}".format(PLUGIN_SRC))
    PLUGIN_DST.parent.mkdir(parents=True, exist_ok=True)
    if PLUGIN_DST.exists():
        shutil.rmtree(PLUGIN_DST)
    shutil.copytree(str(PLUGIN_SRC), str(PLUGIN_DST))

    pkg = PICLIST_DIR / "data" / "package.json"
    deps = {}
    if pkg.exists():
        deps = json.loads(pkg.read_text(encoding="utf-8")).get("dependencies", {})
    deps[PLUGIN_NAME] = "file:./node_modules/{}".format(PLUGIN_NAME)
    for old in OLD_PLUGINS:
        deps.pop(old, None)
    pkg.write_text(
        json.dumps(
            {
                "name": "picgo-plugins",
                "description": "picgo-plugins",
                "dependencies": deps,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main():
    if not CFG_PATH.exists():
        print("跳过：未找到", CFG_PATH)
        return

    cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    plugins = cfg.setdefault("picgoPlugins", {})
    settings = cfg.setdefault("settings", {})

    if AUTO_RENAME:
        install_local_plugin()
        for old in OLD_PLUGINS:
            plugins.pop(old, None)
            cfg.pop(old, None)
        plugins[PLUGIN_NAME] = True
        settings["autoRename"] = False
        settings["rename"] = False
        print("已启用", PLUGIN_NAME, "（格式: YYYYMMDDHHmmssSSS.ext）")
    else:
        plugins.pop(PLUGIN_NAME, None)
        print("已关闭时间戳重命名")

    CFG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("已更新", CFG_PATH)


if __name__ == "__main__":
    main()
