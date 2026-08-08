#!/usr/bin/env python3
"""将 PicList 图床类型从 aws-s3 迁移为 aws-s3-plist（PicList 2.4+）。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CFG_PATH = ROOT / "piclist" / "data" / "config.json"
UPLOADER = "aws-s3-plist"
LEGACY = "aws-s3"


def migrate(cfg):
    pic_bed = cfg.setdefault("picBed", {})
    if pic_bed.get("current") == LEGACY:
        pic_bed["current"] = UPLOADER
    if pic_bed.get("uploader") == LEGACY:
        pic_bed["uploader"] = UPLOADER
    if LEGACY in pic_bed and UPLOADER not in pic_bed:
        pic_bed[UPLOADER] = pic_bed.pop(LEGACY)
    elif LEGACY in pic_bed:
        del pic_bed[LEGACY]

    uploaders = cfg.setdefault("uploader", {})
    if LEGACY in uploaders:
        if UPLOADER not in uploaders:
            uploaders[UPLOADER] = uploaders.pop(LEGACY)
        else:
            del uploaders[LEGACY]
    return cfg


def main():
    if not CFG_PATH.exists():
        print("跳过：未找到", CFG_PATH)
        return
    cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    cfg = migrate(cfg)
    CFG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("已迁移为", UPLOADER)


if __name__ == "__main__":
    main()
