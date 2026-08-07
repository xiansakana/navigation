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
- 门户路径：`/notes/`（保留原入口）

## 鉴权

- **Portal**：登录导航门户（原有账号密码）
- **思源**：Docker 必须设置 `--accessAuthCode`（见 `.env`），首次进入 `/notes/` 时在思源界面输入

参考源码：`d:\code\SiYuan`（siyuan-note/siyuan）
