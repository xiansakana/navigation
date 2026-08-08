# 思源分享服务端（Siyuan Share Web）

自建 [siyuan-plugin-share](https://github.com/b8l8u8e8/siyuan-plugin-share) 的 Web 端，用于生成公开分享链接。

## 部署

```bash
cd siyuan-share
cp .env.example .env          # 可选，改端口或公网地址
cp config.example.php config.php
bash deploy-ecs.sh
```

ECS 默认对外端口：**http://123.56.235.12:6807**（需在安全组放行 6807）

Portal 首页仅提供跳转链接（新标签打开），不再经 `/share` 反代。

## 访问方式

| 入口 | 说明 |
|------|------|
| Portal 首页「笔记分享」 | 外链跳转至 `:6807/dashboard` |
| 直接访问 | `http://123.56.235.12:6807/dashboard`（Share 独立登录） |
| 公开分享页 | `http://123.56.235.12:6807/s/xxxxxxxx` |

插件 **服务端地址** 请填：`http://123.56.235.12:6807`

## 插件配置

1. `/notes/` 安装并启用集市插件 **「思源分享」**（`b8l8u8e8/siyuan-plugin-share`）
2. 打开 **http://123.56.235.12:6807/dashboard** → 登录 Share 管理员 → 生成 **API Key**
3. 插件设置：
   - **服务端地址**：`http://123.56.235.12:6807`
   - **API Key**：粘贴上一步生成的密钥
4. 文档树右键 → **创建分享** → **复制分享链接**

分享链接形如：`http://123.56.235.12:6807/s/xxxxxxxx`

**分享链接前缀**由 Share 数据库 `site_base_url` 决定；`ecs-update` 会从 `.env` 的 `SIYUAN_SHARE_PUBLIC_URL` 自动同步（默认 `http://123.56.235.12:6807`）。也可在 **http://123.56.235.12:6807/admin#settings** 的「网站地址（分享链接前缀）」手动修改。

- `data/storage/` — SQLite 与元数据
- `data/uploads/` — 分享页资源

## 环境变量（`.env`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `SIYUAN_SHARE_PORT` | `6807` | 宿主机监听端口（`0.0.0.0:6807`） |
| `SIYUAN_SHARE_PUBLIC_URL` | `http://123.56.235.12:6807` | 对外公开地址；同步到 Share `site_base_url` 与 Portal 外链 |
| `SIYUAN_SHARE_ALLOW_REGISTRATION` | `0` | 是否开放公开注册；自建建议 `0`，仅 `admin` 等已有账号登录 |

## 账号与注册

自建默认 **关闭公开注册**（`.env` 中 `SIYUAN_SHARE_ALLOW_REGISTRATION=0`）。管理员在 **http://123.56.235.12:6807/login** 登录即可；也可在管理后台 **设置** 里勾选「允许注册」临时开放。

## 界面主题

仓库自带 **Portal 深色对齐主题**：[`share-theme-portal.css`](share-theme-portal.css)

- **手动**：管理员 → **http://123.56.235.12:6807/admin#settings** → 自定义 CSS → 粘贴该文件内容 → 勾选「启用自定义 CSS」
- **自动**：`python3 scripts/sync-share-theme.py`（`ecs-update` 在更新 siyuan-share 时会执行）

可在该 CSS 顶部改 `:root` 变量微调配色；Share 官方也在同一页提供自定义 CSS/JS 说明与示例。
