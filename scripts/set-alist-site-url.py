#!/usr/bin/env python3
"""将 AList site_url 设为公网 Portal 地址（分享/下载链接用，勿用 127.0.0.1）。"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "alist" / "data" / "config.json"
# 完整公网基址；仅 /alist 时分享链接会跟请求 Host 变成 127.0.0.1:5244
SITE_URL = os.environ.get("ALIST_SITE_URL", "http://123.56.235.12/alist").rstrip("/")


def main():
    if not CONFIG_PATH.exists():
        print("alist config not found yet:", CONFIG_PATH, file=sys.stderr)
        return 1
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    current = (cfg.get("site_url") or "").rstrip("/")
    if current == SITE_URL:
        print("alist site_url already", SITE_URL)
        return 0
    cfg["site_url"] = SITE_URL
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("alist site_url set ->", SITE_URL, "in", CONFIG_PATH)
    try:
        subprocess.run(
            ["docker", "compose", "-f", str(ROOT / "alist" / "docker-compose.yml"), "restart"],
            check=False,
            cwd=str(ROOT / "alist"),
        )
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
