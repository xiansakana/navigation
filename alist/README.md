# AList

网盘聚合（Docker），仅监听 `127.0.0.1:5244`，经 Portal 反代为 `/alist/`。

## 部署

```bash
# 随 ecs-update 自动执行，或单独：
cd /opt/navigation/alist
bash deploy-ecs.sh
```

首次启动后脚本会把 `data/config.json` 的 `site_url` 设为 `/alist`，并执行 `scripts/configure-alist.py`：

- 挂载本地目录 `alist/files` → `/本地`
- 复用 PicList 的 Backblaze B2 → `/B2图床`
- 写入站点标题等基础设置
- 管理员密码保存在 `alist/data/.admin-password`（已 gitignore）

## 管理密码

```bash
cat /opt/navigation/alist/data/.admin-password
docker exec alist ./alist admin set '你的强密码'
# 重置后重新跑配置脚本写入密码文件：
ALIST_RESET_PASSWORD=1 python3 /opt/navigation/scripts/configure-alist.py
```

## Portal

服务项由 `scripts/sync-portal-alist.py` 写入 `portal/config.json`（`type: proxy`，`upstreamPathPrefix: /alist`）。
