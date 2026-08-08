# 思源笔记（SiYuan）

## 部署

```bash
cd siyuan
cp .env.example .env   # 修改 SIYUAN_ACCESS_AUTH_CODE
docker compose up -d
```

ECS 一键：

```bash
bash siyuan/deploy-ecs.sh
```

- 数据目录：`siyuan/data/siyuan/`（挂载为 workspace）
- 本地端口：`127.0.0.1:6806`（仅本机，经 portal 反代对外）
- 门户路径：`/notes/`（保留原入口；手机浏览器会自动进入移动版 UI）

## 移动端

- 经 portal 访问时，会根据浏览器 User-Agent 进入 `/stage/build/mobile/` 或 desktop 版
- 日常手机使用更推荐安装 **思源官方 App**，通过云端同步同一工作空间

## 鉴权

- **Portal**：登录导航门户（原有账号密码）
- **思源**：Docker 必须设置 `--accessAuthCode`（见 `.env`），首次进入 `/notes/` 时在思源界面输入

## 定时备份

ECS 上每天凌晨 3 点自动备份 workspace（停容器 → tar → 启动），保留最近 7 份：

```bash
./scripts/install-siyuan-backup-cron.sh   # 首次安装 cron
./scripts/backup-siyuan.sh                # 手动立即备份
```

- 备份目录：`/opt/backups/siyuan/`
- 日志：`/var/log/siyuan-backup.log`

参考源码：`d:\code\SiYuan`（siyuan-note/siyuan）
