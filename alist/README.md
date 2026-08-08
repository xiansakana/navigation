# AList

网盘聚合（Docker），仅监听 `127.0.0.1:5244`，经 Portal 反代为 `/alist/`。

## 部署

```bash
# 随 ecs-update 自动执行，或单独：
cd /opt/navigation/alist
bash deploy-ecs.sh
```

首次启动后脚本会把 `data/config.json` 的 `site_url` 设为 `/alist`，并执行 `scripts/configure-alist.py`：

- **仅创建**尚未存在的挂载（`/本地`、`/B2图床`、以及 `tokens.env` 里有凭证的网盘）
- **不改**站点公告、分页、已有存储等你在后台配过的项（均已在 sqlite 持久化）
- 管理员密码明文备份：`alist/data/.admin-password`（已 gitignore）

强制覆盖已有挂载：`ALIST_FORCE_STORAGE_UPDATE=1 python3 scripts/configure-alist.py`

## 管理密码

密码存在 `alist/data/data.db`（sqlite），**容器重启不会变**。  
`data/.admin-password` 只是给运维脚本登录用的明文备份（已 gitignore），不会自动改密。

```bash
# 查看脚本用的明文备份
cat /opt/navigation/alist/data/.admin-password

# 仅在你主动改密时执行（会同步写回 .admin-password）
ALIST_RESET_PASSWORD=1 ALIST_ADMIN_PASSWORD='你的强密码' \
  python3 /opt/navigation/scripts/configure-alist.py
# 或：
docker exec alist ./alist admin set '你的强密码'
echo '你的强密码' > /opt/navigation/alist/data/.admin-password
```

## 网盘 Token

复制 `tokens.example.env` → `tokens.env`，按注释链接扫码拿到 refresh_token 后填写，再执行：

```bash
python3 /opt/navigation/scripts/configure-alist.py
```

可挂载：阿里云盘 / 百度网盘 / OneDrive / GoogleDrive / 115（有 token 才创建）。

## Portal

服务项由 `scripts/sync-portal-alist.py` 写入 `portal/config.json`（`type: proxy`，`upstreamPathPrefix: /alist`）。
