# 笔记模块（已替换）

自研 TipTap 笔记已替换为 **[思源笔记 SiYuan](../siyuan/README.md)**。

- 门户入口仍为 `/notes/`
- 后端：`docker compose` 运行 `b3log/siyuan`，端口 `6806`
- 本目录代码保留，如需回滚可将 portal `config.json` 中 notes 的 `internalUrl` 改回 `http://127.0.0.1:5001` 并重启 notes 进程
