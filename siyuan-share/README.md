# 思源分享服务端（Siyuan Share Web）

自建 [siyuan-plugin-share](https://github.com/b8l8u8e8/siyuan-plugin-share) 的 Web 端，用于生成公开分享链接。

## 部署

```bash
cd siyuan-share
cp .env.example .env          # 可选，改端口
cp config.example.php config.php
bash deploy-ecs.sh
```

ECS 默认经 Portal 反代：**http://123.56.235.12/share**（管理页需 portal 登录；公开分享页 `/share/s/xxx` 无需登录）

本地调试端口：`127.0.0.1:6807`（仅 ECS 本机，不对外暴露）

## Portal 反代（推荐）

| 路径 | Portal 鉴权 | 说明 |
|------|-------------|------|
| `/share/s/*` | 否 | 公开分享页 |
| `/share/api/v1/*` | 否 | 思源插件 API（Share 自身校验 API Key） |
| `/share/login`、`/dashboard` 等 | **是** | 须 portal 已登录 + `service:siyuan-share:view`；**已登录 portal 后会自动进入 Share 控制台**（无需再输 Share 密码） |

在 `siyuan-share/.env` 可配置 `SHARE_SSO_USERNAME` / `SHARE_SSO_PASSWORD`；**留空则默认使用 portal 的 admin 账号密码**（须与 Share 站管理员密码一致）。

插件 **服务端地址** 请填：`http://123.56.235.12/share`（不要再用 `:6807`）

管理入口（登录 portal 后）：**http://123.56.235.12/share/dashboard**

6807 安全组可关闭，仅保留 80 即可。
## 插件配置

1. `/notes/` 安装并启用集市插件 **「思源分享」**
2. 登录 portal 后打开 **http://123.56.235.12/share/dashboard**（自动登录 Share）→ 生成 **API Key**
3. 插件设置：
   - **服务端地址**：`http://123.56.235.12/share`
   - **API Key**：粘贴上一步生成的密钥
4. 文档树右键 → **创建分享** → **复制分享链接**

分享链接形如：`http://123.56.235.12/share/s/xxxxxxxx`

**分享链接前缀**由 Share 数据库 `site_base_url` 决定；`ecs-update` 会从 `.env` 的 `SIYUAN_SHARE_PUBLIC_URL` 自动同步（默认 `http://123.56.235.12/share`）。也可在 **http://123.56.235.12/share/admin#settings** 的「网站地址（分享链接前缀）」手动修改（须 Share 管理员）。

- `data/storage/` — SQLite 与元数据
- `data/uploads/` — 分享页资源

## 环境变量（`.env`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `SIYUAN_SHARE_PORT` | `6807` | 宿主机监听端口 |
| `SIYUAN_SHARE_PUBLIC_URL` | `http://123.56.235.12:6807` | 部署脚本提示用，需与插件填写的地址一致 |
