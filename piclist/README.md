# PicList HTTP 图床服务

在 ECS 上以 Docker 运行 [PicList](https://github.com/Kuingsmile/PicList) 内置的 `picgo-server`，供 Typora、Obsidian、PicHoro 等通过 HTTP 上传图片到 Backblaze B2（经 `assets.saoyu.fun` 域名访问）。

## 部署

```bash
cd piclist
cp .env.example .env          # 设置 PICLIST_SERVER_KEY
cp config.example.json data/config.json   # 首次由 deploy-ecs.sh 自动复制
# 编辑 data/config.json 填入 B2 Application Key
bash deploy-ecs.sh
```

ECS 默认对外端口：**http://123.56.235.12:36677**（需在安全组放行 **36677**）

仓库根目录执行 `./scripts/ecs-update.sh --only piclist` 可重建镜像并重启容器。

若 ECS 可访问 Docker Hub，也可改用官方镜像：在 `docker-compose.yml` 中将 `image` 改为 `kuingsmile/piclist:latest` 并删除 `build: .`。

## 公网访问

| 项 | 值 |
|----|-----|
| 服务地址 | `http://123.56.235.12:36677` |
| 上传接口 | `POST/PUT http://123.56.235.12:36677/upload?key=<密钥>` |
| 鉴权 | URL 参数 `key`，对应 `.env` 的 `PICLIST_SERVER_KEY` |

**务必**设置强 `PICLIST_SERVER_KEY`，否则公网暴露后可能被恶意上传。

## 客户端配置

### Typora

1. 偏好设置 → 图像 → 上传服务：**PicGo (app)**
2. PicGo 路径可留空；PicList ≥ 1.6 可选 PicList
3. API 地址：`http://123.56.235.12:36677/upload?key=你的密钥`

### Obsidian（Image Auto Upload Plugin）

- Default Uploader：PicGo(app)
- API Endpoint：`http://123.56.235.12:36677/upload?key=你的密钥`

### PicHoro（手机）

- 服务器地址：`http://123.56.235.12:36677`
- 密钥：与 `PICLIST_SERVER_KEY` 相同

## 图床存储（Backblaze B2）

`data/config.json` 默认使用 **aws-s3-plist**（S3 兼容）上传到桶 `xiansakana-assets`，返回链接前缀 `https://assets.saoyu.fun`。

需在 [Backblaze](https://www.backblaze.com) 创建 **Application Key**（仅需该桶读写权限），填入：

- `accessKeyID`
- `secretAccessKey`

若桶所在 region 不是 `us-west-004`，请同步修改 `region` 与 `endpoint`（与 B2 控制台 S3 兼容 API 一致）。

`assets.saoyu.fun` 需在 Cloudflare 配置 SSL **完全（严格）** 与 URL 重写规则，否则外链可能 521/404（见 Hexo 文章《图床使用方案》）。

## 文件名（时间戳）

默认通过自建插件 **`picgo-plugin-datetime-rename`** 重命名（`picgo-server` 不识别桌面版 `settings.autoRename`）。

上传后文件名形如：`202608081950112.png`（`YYYYMMDDHHmmss` + 毫秒百位，共 15 位数字 + 扩展名）。

```bash
python3 scripts/sync-piclist-rename.py
cd piclist && docker compose restart
```

关闭时间戳命名：`PICLIST_AUTO_RENAME=0 python3 scripts/sync-piclist-rename.py`

## 环境变量（`.env`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PICLIST_PORT` | `36677` | 宿主机监听端口 |
| `PICLIST_PUBLIC_URL` | `http://123.56.235.12:36677` | 文档与客户端使用的公网地址 |
| `PICLIST_SERVER_KEY` | — | HTTP 上传鉴权密钥（必填） |

## 数据目录

- `data/config.json` — 图床配置（含 B2 密钥，**勿提交 Git**）
- 容器内路径 `/root/.piclist`
