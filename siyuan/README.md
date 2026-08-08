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
- 本地端口：`127.0.0.1:6806`（编辑，经 Portal `/notes/`）
- 发布端口：`127.0.0.1:6808`（只读发布站，经 Portal `/publish/`，**无需登录 Portal**）
- 门户路径：`/notes/`（须先登录 Portal；手机浏览器会自动进入移动版 UI）

## 内置发布站

1. Docker 已映射 `6808`，Portal 反代到 **`/publish/`**（公开访问，无需 Portal 登录）
2. 在思源 **设置 → 发布服务** 中开启，端口保持 **6808**
3. 将需要公开的笔记本设为 **公开**（右键笔记本 → 属性/发布相关设置）
4. 访问：**http://你的域名或IP/publish/**

与 Siyuan Share（`:6807` 单篇分享）不同，发布站适合整站/多笔记本只读展示。

Portal 对 `/publish/` 会强制 `loadPetals` 使用 `frontend=publish`（只加载思源发布白名单插件），并拦截 PicGo / 分享插件静态目录，避免游客看到图床密钥等配置入口。

## 访问控制

- **6806 / 6099 不对公网开放**，仅 Portal（`:80`）对外
- Portal 登录 + RBAC 决定谁能看到/进入 `/notes/`、`/napcat/`
- 思源自身仍有锁屏密码（`SIYUAN_ACCESS_AUTH_CODE`），NapCat 仍有 WebUI token

## 移动端

- 经 portal 访问时，会根据浏览器 User-Agent 进入 mobile 或 desktop 版
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

## 分享（Siyuan Share 自建）

- 管理/API Key：**http://123.56.235.12:6807/dashboard**（Share 独立登录）
- 公开分享页：**http://123.56.235.12:6807/s/xxx**
- 插件服务端地址填 `http://123.56.235.12:6807`
- Portal 首页仅提供跳转链接

详见 [`siyuan-share/README.md`](../siyuan-share/README.md)。

## PicGo 图床插件（浏览器 / Docker）

经 Portal 在**浏览器**里用思源时，插件跑在前端，**不能用「内置 PicGo」**，应走 ECS 上的 **远程 PicList**：

| 配置项 | 正确值 |
|--------|--------|
| 使用内置 PicGo | **关**（`useBundledPicgo: false`） |
| PicGo 类型 | **App**（`picgoType: app`） |
| PicList API 地址 | `http://123.56.235.12:36677/upload`（须含 `/upload`） |
| PicList API 密钥 | 与 `piclist/.env` 的 `PICLIST_SERVER_KEY` 一致（当前 `siyuan-web`） |

工作空间配置文件：`data/storage/syp/picgo/external-picgo-cfg.json`

ECS 一键同步：

```bash
PICLIST_SERVER_KEY=siyuan-web python3 scripts/sync-siyuan-picgo-external.py
```

`ecs-update` 在更新 piclist 后会自动执行（从 `piclist/.env` 读取密钥）。

**勿填** `http://127.0.0.1:36677` 作为远程地址——那是你**自己电脑**上的 PicGo，浏览器访问云端思源时连不到。

参考源码：`d:\code\SiYuan`（siyuan-note/siyuan）
