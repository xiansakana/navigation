# AList

网盘聚合（Docker），仅监听 `127.0.0.1:5244`，经 Portal 反代为 `/alist/`。

## 部署

```bash
# 随 ecs-update 自动执行，或单独：
cd /opt/navigation/alist
bash deploy-ecs.sh
```

首次启动后脚本会把 `data/config.json` 的 `site_url` 设为 `/alist`。

## 管理密码

```bash
docker exec alist ./alist admin
docker exec alist ./alist admin set '你的强密码'
```

## Portal

服务项由 `scripts/sync-portal-alist.py` 写入 `portal/config.json`（`type: proxy`，`upstreamPathPrefix: /alist`）。
