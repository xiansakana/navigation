#!/usr/bin/env python3
"""为 PicList 服务端启用时间戳自动重命名（picgo-plugin-rename）。"""
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PICLIST_DIR = ROOT / "piclist"
CFG_PATH = PICLIST_DIR / "data" / "config.json"
PLUGIN = "picgo-plugin-rename"

# picgo-server 不读取 settings.autoRename，需用 beforeUpload 插件
AUTO_RENAME = os.environ.get("PICLIST_AUTO_RENAME", "1") not in ("0", "false", "False")


def ensure_plugin_installed():
    try:
        subprocess.run(
            ["docker", "compose", "exec", "-T", "piclist", "picgo", "install", PLUGIN],
            cwd=str(PICLIST_DIR),
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
        )
    except OSError:
        pass


def main():
    if not CFG_PATH.exists():
        print("跳过：未找到", CFG_PATH)
        return

    if AUTO_RENAME:
        ensure_plugin_installed()

    cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    plugins = cfg.setdefault("picgoPlugins", {})
    settings = cfg.setdefault("settings", {})

    if AUTO_RENAME:
        plugins[PLUGIN] = True
        settings["autoRename"] = False
        settings["rename"] = False
        print("已启用插件", PLUGIN, "（文件名: 毫秒时间戳-md5.ext）")
    else:
        plugins.pop(PLUGIN, None)
        print("已关闭时间戳重命名")

    CFG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("已更新", CFG_PATH)


if __name__ == "__main__":
    main()
