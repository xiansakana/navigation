#!/usr/bin/env python3
"""同步思源 PicGo 插件的外部 PicList 路由配置（Docker/浏览器环境）。"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CFG_PATH = ROOT / "siyuan" / "data" / "siyuan" / "data" / "storage" / "syp" / "picgo" / "external-picgo-cfg.json"

PICLIST_URL = os.environ.get("PICLIST_PUBLIC_URL", "http://123.56.235.12:36677").rstrip("/")
PICLIST_KEY = os.environ.get("PICLIST_SERVER_KEY", "siyuan-web")


def main():
    if not CFG_PATH.exists():
        print("跳过：未找到", CFG_PATH)
        return

    upload_url = PICLIST_URL + "/upload"
    cfg = {
        "useBundledPicgo": False,
        "picgoType": "app",
        "extPicgoApiUrl": "http://127.0.0.1:36677",
        "picListApiUrl": upload_url,
        "picListApiKey": PICLIST_KEY,
    }
    CFG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CFG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("已写入思源 PicGo 外部配置:", CFG_PATH)
    print("  useBundledPicgo=false, picgoType=app")
    print("  picListApiUrl=", upload_url)
    print("  picListApiKey=", PICLIST_KEY)


if __name__ == "__main__":
    main()
