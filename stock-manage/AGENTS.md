# stock-manage（navigation 子服务）

## 架构

- **前端**: Vite + TypeScript + Tailwind，单页应用（`src/main.ts`）
- **后端**: Express（`server/server.ts`），同一进程提供 API 与静态资源
- **数据**: 服务端 JSON 文件 `data/portfolio.json`（持仓、交易、界面偏好）
- **行情**: Finnhub / Polygon 代理（`server/routes/stocks.ts`）

## 与 portal 集成

- 独立进程监听 `127.0.0.1:5000`
- portal 反代路径 `/stock-manage`，`injectBar: false`（避免 portal.css 影响 Tailwind）
- 生产构建需 `VITE_BASE_PATH=/stock-manage/`

## 持久化 API

- `GET /api/data` — 读取完整快照
- `PUT /api/data` — 保存 `{ portfolio, trades, settings }`

## 开发

```bash
npm install
npm run dev    # http://127.0.0.1:5000
npm run build  # dist/ + dist-server/
```

## ECS

```bash
./deploy-ecs.sh
# pm2 进程名: stock-manage
```
