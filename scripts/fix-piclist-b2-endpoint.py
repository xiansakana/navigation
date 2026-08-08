#!/usr/bin/env python3
"""修正 PicList B2 S3 endpoint（f005 -> us-east-005）。"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CFG_PATH = ROOT / "piclist" / "data" / "config.json"
REGION = "us-east-005"
ENDPOINT = "https://s3.us-east-005.backblazeb2.com"


def patch_block(block):
    if not isinstance(block, dict):
        return
    block["region"] = REGION
    block["endpoint"] = ENDPOINT


def main():
    if not CFG_PATH.exists():
        print("跳过：未找到", CFG_PATH)
        return
    cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    for key in ("aws-s3-plist", "aws-s3"):
        patch_block(cfg.get("picBed", {}).get(key))
        for item in cfg.get("uploader", {}).get(key, {}).get("configList", []):
            patch_block(item)
    CFG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("已设置 B2 S3 endpoint:", ENDPOINT)


if __name__ == "__main__":
    main()
