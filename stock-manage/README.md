# 股票管理（navigation 子服务）

美股与 A 股（含场内 ETF）持仓、交易记录、盈亏统计。运行时数据统一写入仓库根目录 `data/navigation.db`（与 Portal RBAC 共用）；首次启动会自动从 `data/portfolio.json` 导入（若 DB 为空）。

现金为双币种：`cashUsd` + `cashCny`，总资产与权重按 `usdCnyRate` 折成美元。A 股代码（6 位，可带 SH/SZ）自动记为 CNY；行情走腾讯 / 新浪 / 东财（Yahoo 兜底）。盈亏曲线里的人民币交易按**当前汇率**折美元（MVP，非历史汇率）。

抄底监控与 QQ 提醒是独立服务 `qqq-dip`（:5001），从页面顶部 Tab 进入 `/stock-manage/dip/`，不读写本服务的持仓与现金。

## 本地开发

```bash
cd stock-manage
npm install
npm test
npm start
```

浏览器打开 http://127.0.0.1:5000

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
| `dbPath` | SQLite 路径，默认仓库 `data/navigation.db` |

行情 API 密钥通过环境变量 `FINNHUB_API_KEY`、`POLYGON_API_KEY` 覆盖（美股/期权）。A 股不依赖这些 Key。

## API（常用）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/portfolio` | 持仓、双币种现金、汇总 |
| PUT | `/api/cash` | `{ cashUsd, cashCny, usdCnyRate? }`（兼容旧字段 `cash`→美元） |
| POST | `/api/trades` | 记一笔（可带 `currency`） |
| POST | `/api/quotes/refresh` | 刷新持仓行情并更新汇率 |
| GET | `/api/stock/:symbol` | 股票/A股报价 |
| GET | `/api/option/:symbol` | Polygon 期权报价 |
| GET | `/api/search` | 代码搜索 |
