# 股票管理（navigation 子服务）

美股持仓、交易记录、盈亏统计。运行时数据统一写入仓库根目录 `data/navigation.db`（与 Portal RBAC 共用）；首次启动会自动从 `data/portfolio.json` 导入（若 DB 为空）。

## 本地开发

```bash
cd stock-manage
npm install
npm run dev
```

浏览器打开 http://127.0.0.1:5000

## 生产构建

```bash
npm run build
COZE_PROJECT_ENV=PROD NODE_ENV=production npm start
```

## ECS 部署

```bash
cd /opt/navigation/stock-manage
./deploy-ecs.sh
```

portal 中访问路径：`/stock-manage/`（需在 `portal/config.json` 注册，`injectBar: false` 以免样式冲突）。

## 配置

复制 `config.example.json` 为 `config.json`：

| 字段 | 说明 |
|------|------|
| `server.host` | 监听地址，ECS 用 `127.0.0.1` |
| `server.port` | 默认 `5000` |
| `dataDir` | 数据目录，默认 `data/` |

行情 API 密钥通过环境变量 `FINNHUB_API_KEY`、`POLYGON_API_KEY` 覆盖。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/data` | 读取持仓、交易、界面偏好 |
| PUT | `/api/data` | 保存完整快照 |
| GET | `/api/stock/:symbol` | Finnhub 股票报价 |
| GET | `/api/option/:symbol` | Polygon 期权报价 |
| GET | `/api/search` | 代码搜索 |
