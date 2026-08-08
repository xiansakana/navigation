#!/usr/bin/env python3
"""在 ECS 上写入 PicList B2 凭证与 HTTP 密钥（勿把密钥提交 Git）。"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PICLIST_DIR = ROOT / "piclist"
ENV_PATH = PICLIST_DIR / ".env"
CFG_PATH = PICLIST_DIR / "data" / "config.json"


def set_env_key(key: str) -> None:
    text = ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""
    line = "PICLIST_SERVER_KEY={}\n".format(key)
    if re.search(r"^PICLIST_SERVER_KEY=", text, flags=re.M):
        text = re.sub(r"^PICLIST_SERVER_KEY=.*$", line.rstrip(), text, flags=re.M)
    else:
        text = text.rstrip("\n") + ("\n" if text else "") + line
    ENV_PATH.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")


UPLOADER = "aws-s3-plist"


def set_b2(access_key_id: str, secret_access_key: str) -> None:
    if not CFG_PATH.exists():
        raise SystemExit("缺少 {}，请先运行 piclist/deploy-ecs.sh".format(CFG_PATH))
    cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    b2 = {"accessKeyID": access_key_id, "secretAccessKey": secret_access_key}
    cfg.setdefault("picBed", {}).setdefault(UPLOADER, {}).update(b2)
    for item in cfg.get("uploader", {}).get(UPLOADER, {}).get("configList", []):
        item.update(b2)
    CFG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    access_key_id = os.environ.get("B2_ACCESS_KEY_ID") or (sys.argv[1] if len(sys.argv) > 1 else "")
    secret = os.environ.get("B2_SECRET_ACCESS_KEY") or (sys.argv[2] if len(sys.argv) > 2 else "")
    server_key = os.environ.get("PICLIST_SERVER_KEY") or (sys.argv[3] if len(sys.argv) > 3 else "")
    if not all([access_key_id, secret, server_key]):
        print("用法: B2_ACCESS_KEY_ID=... B2_SECRET_ACCESS_KEY=... PICLIST_SERVER_KEY=... python3 scripts/set-piclist-secrets.py")
        sys.exit(1)
    set_b2(access_key_id, secret)
    set_env_key(server_key)
    print("已更新 {} 与 {}".format(CFG_PATH.name, ENV_PATH.name))


if __name__ == "__main__":
    main()
