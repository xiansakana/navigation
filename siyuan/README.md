# 思源笔记（SiYuan）替换自研 notes 模块。

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
- 门户路径：`/notes/`（保留原入口）

## 鉴权

- **Portal**：登录导航门户（原有账号密码）
- **思源**：Docker 必须设置 `--accessAuthCode`（见 `.env`），首次进入 `/notes/` 时在思源界面输入

## 与自研 notes 的区别

| 自研 notes | 思源 SiYuan |
|-----------|-------------|
| 轻量 JSON 存储 | 完整 PKM + SQLite |
| 深度集成 portal UI | 独立完整界面 |
| 可 Markdown 导入 | Docker 版不支持 Markdown 导入 |

自研代码保留在 `notes/` 目录，如需回滚可改 portal 配置指回 `:5001` 并 `pm2 restart notes`。

参考源码：`d:\code\SiYuan`（siyuan-note/siyuan）
