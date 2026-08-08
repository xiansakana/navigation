#!/usr/bin/env python3
"""配置 AList：站点项、本地存储、复用 PicList 的 B2（S3）。在 ECS 上对 127.0.0.1:5244 调用管理 API。"""
import json
import os
import secrets
import string
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALIST_BASE = os.environ.get("ALIST_BASE", "http://127.0.0.1:5244").rstrip("/")
PICLIST_CFG = Path(os.environ.get("PICLIST_CONFIG", str(ROOT / "piclist" / "data" / "config.json")))
PASSWORD_FILE = Path(os.environ.get("ALIST_PASSWORD_FILE", str(ROOT / "alist" / "data" / ".admin-password")))


def api(method, path, token=None, body=None):
    data = None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        ALIST_BASE + path, data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise SystemExit("AList API %s %s -> HTTP %s: %s" % (method, path, e.code, raw[:300]))


def ensure_ok(resp, what):
    if not resp or resp.get("code") != 200:
        raise SystemExit("%s failed: %s" % (what, json.dumps(resp, ensure_ascii=False)[:500]))
    return resp.get("data")


def gen_password(n=20):
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def set_admin_password(password):
    r = subprocess.run(
        ["docker", "exec", "alist", "./alist", "admin", "set", password],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise SystemExit("set admin password failed: %s%s" % (r.stdout, r.stderr))
    PASSWORD_FILE.parent.mkdir(parents=True, exist_ok=True)
    PASSWORD_FILE.write_text(password + "\n", encoding="utf-8")
    try:
        PASSWORD_FILE.chmod(0o600)
    except OSError:
        pass
    print("admin password written to", PASSWORD_FILE)


def login(password):
    data = ensure_ok(
        api("POST", "/api/auth/login", body={"username": "admin", "password": password}),
        "login",
    )
    return data["token"]


def list_storages(token):
    data = ensure_ok(api("GET", "/api/admin/storage/list?page=1&per_page=100", token), "list storage")
    return data.get("content") or []


def upsert_storage(token, payload):
    existing = {s.get("mount_path"): s for s in list_storages(token)}
    mount = payload["mount_path"]
    if mount in existing:
        body = dict(existing[mount])
        body.update(payload)
        body["id"] = existing[mount]["id"]
        ensure_ok(api("POST", "/api/admin/storage/update", token, body), "update " + mount)
        print("storage updated:", mount)
        return
    ensure_ok(api("POST", "/api/admin/storage/create", token, payload), "create " + mount)
    print("storage created:", mount)


def read_b2_from_piclist():
    if not PICLIST_CFG.exists():
        return None
    cfg = json.loads(PICLIST_CFG.read_text(encoding="utf-8"))
    b2 = (cfg.get("picBed") or {}).get("aws-s3-plist") or {}
    if not b2.get("accessKeyID") or not b2.get("secretAccessKey") or not b2.get("bucketName"):
        return None
    return b2


def apply_settings(token):
    wanted = {
        "site_title": "AList 网盘",
        "announcement": "经 Portal /alist/ 访问；本地目录与 B2 图床桶已挂载。",
        "pagination_type": "all",
        "default_page_size": "50",
        "allow_indexed": "false",
        "allow_mounted_access": "true",
        "hide_files": "/\\/README.md/i",
    }
    data = ensure_ok(api("GET", "/api/admin/setting/list", token), "list settings")
    items = data if isinstance(data, list) else (data.get("content") or data or [])
    by_key = {i.get("key"): i for i in items if isinstance(i, dict) and i.get("key")}
    payload = []
    for key, value in wanted.items():
        if key not in by_key:
            continue
        item = dict(by_key[key])
        if str(item.get("value")) == str(value):
            continue
        item["value"] = value
        payload.append(item)
    if not payload:
        print("settings already up to date")
        return
    ensure_ok(api("POST", "/api/admin/setting/save", token, payload), "save settings")
    print("settings updated:", ", ".join(i["key"] for i in payload))


def main():
    password = os.environ.get("ALIST_ADMIN_PASSWORD", "").strip()
    reset = os.environ.get("ALIST_RESET_PASSWORD", "").strip() in ("1", "true", "yes")
    if not password and PASSWORD_FILE.exists():
        password = PASSWORD_FILE.read_text(encoding="utf-8").strip()
    if not password or reset:
        password = password or gen_password()
        set_admin_password(password)
    else:
        # 尝试登录；失败则重置
        try:
            login(password)
        except SystemExit:
            password = gen_password()
            set_admin_password(password)

    token = login(password)
    apply_settings(token)

    upsert_storage(
        token,
        {
            "mount_path": "/本地",
            "order": 0,
            "remark": "ECS 本地目录 alist/files",
            "cache_expiration": 30,
            "web_proxy": False,
            "webdav_policy": "native_proxy",
            "down_proxy_url": "",
            "down_proxy_sign": True,
            "extract_folder": "front",
            "enable_sign": False,
            "driver": "Local",
            "order_by": "name",
            "order_direction": "asc",
            "addition": json.dumps(
                {
                    "root_folder_path": "/data/files",
                    "thumbnail": False,
                    "thumb_cache_folder": "",
                    "show_hidden": False,
                    "mkdir_perm": "755",
                },
                ensure_ascii=False,
            ),
        },
    )

    b2 = read_b2_from_piclist()
    if b2:
        custom_host = (b2.get("urlPrefix") or "").rstrip("/")
        addition = {
            "root_folder_path": "/",
            "bucket": b2["bucketName"],
            "endpoint": b2.get("endpoint") or "https://s3.us-east-005.backblazeb2.com",
            "region": b2.get("region") or "us-east-005",
            "access_key_id": b2["accessKeyID"],
            "secret_access_key": b2["secretAccessKey"],
            "session_token": "",
            "custom_host": custom_host,
            "enable_custom_host_presign": False,
            "sign_url_expire": 4,
            "placeholder": ".alist",
            "force_path_style": bool(b2.get("pathStyleAccess", True)),
            "list_object_version": "v2",
            "remove_bucket": bool(b2.get("disableBucketPrefixToURL", True)),
            "add_filename_to_disposition": True,
        }
        upsert_storage(
            token,
            {
                "mount_path": "/B2图床",
                "order": 1,
                "remark": "Backblaze B2 xiansakana-assets（与 PicList 共用）",
                "cache_expiration": 30,
                "web_proxy": False,
                "webdav_policy": "302_redirect",
                "down_proxy_url": "",
                "down_proxy_sign": True,
                "extract_folder": "front",
                "enable_sign": False,
                "driver": "S3",
                "order_by": "name",
                "order_direction": "asc",
                "addition": json.dumps(addition, ensure_ascii=False),
            },
        )
    else:
        print("skip B2: piclist B2 credentials not found in", PICLIST_CFG)

    ensure_ok(api("POST", "/api/admin/storage/load_all", token), "load_all")
    storages = list_storages(token)
    print("storages:")
    for s in storages:
        print(" -", s.get("mount_path"), s.get("driver"), s.get("status"))
    print("login: admin / (see", PASSWORD_FILE, ")")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
