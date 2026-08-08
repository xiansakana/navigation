# 思源分享服务端（Siyuan Share Web）

自建 [siyuan-plugin-share](https://github.com/b8l8u8e8/siyuan-plugin-share) 的 Web 端，用于生成公开分享链接。

## 部署

```bash
cd siyuan-share
cp .env.example .env          # 可选，改端口
cp config.example.php config.php
bash deploy-ecs.sh
```

ECS 默认：**http://123.56.235.12:6807**（需在阿里云安全组放行 TCP 6807）

## 插件配置

1. `/notes/` 安装并启用集市插件 **「思源分享」**
2. 打开 **http://123.56.235.12:6807** 注册 → 登录 → 生成 **API Key**
3. 插件设置：
   - **服务端地址**：`http://123.56.235.12:6807`（不要末尾 `/`）
   - **API Key**：粘贴上一步生成的密钥
4. 文档树右键 → **创建分享** → **复制分享链接**

分享链接形如：`http://123.56.235.12:6807/s/xxxxxxxx`

## 数据目录

- `data/storage/` — SQLite 与元数据
- `data/uploads/` — 分享页资源

## 环境变量（`.env`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `SIYUAN_SHARE_PORT` | `6807` | 宿主机监听端口 |
| `SIYUAN_SHARE_PUBLIC_URL` | `http://123.56.235.12:6807` | 部署脚本提示用，需与插件填写的地址一致 |
