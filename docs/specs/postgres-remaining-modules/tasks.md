# 任务清单：剩余四模块迁移 PostgreSQL

状态：已完成（2026-11-27）
图例：`[ ]` 待办，`[x]` 完成。

## Phase 0 基础

- [x] T0.1 `shared/db/postgres/config.js` 增加 `bookkeeping`、`portfolio`、`qqqDip` scope
- [x] T0.2 `shared/db/postgres/config.test.js` 覆盖新 scope 与生产目标一致性
- [x] T0.3 新增 `shared/db/postgres/002-qqq-dip-state.sql`（幂等 DDL）
- [x] T0.4 `qqq-dip/package.json` 增加 `pg@8.23.1` 并更新锁文件（如仓库有）
- [x] T0.5 更新 `docs/postgres-migration.md`：变量、002 执行、切换/回滚
- [x] T0.6 本地跑 `shared` 与 `config` 测试，提交推送

## Phase 1 实盘组合 + 抄底资金

### 纯函数重构（SQLite 行为不变）

- [x] T1.1 `shared/investment-accounts.js` 抽出 `projectInvestmentsFrom`
- [x] T1.2 抽出 `planHistoricalTradeCashCorrections`、`planHistoricalPositionAllocations`
- [x] T1.3 `projectInvestments` / `allocateHistoricalPositions` / `applyHistoricalTradeCashCorrections` 委托纯函数，保持输出一致
- [x] T1.4 `shared/dip-cash-funds.js` 抽出 `dipCashFundsFrom`、`planDipCashRules`
- [x] T1.5 `dipCashFunds` / `setDipCashReserve` / `applyDipCashRules` 委托纯函数
- [x] T1.6 `shared/db/portfolio-store.js` 读写改用纯函数
- [x] T1.7 跑 `stock-manage` 现有组合/投资账户/抄底测试，确保全绿

### PG repository

- [x] T1.8 新增 `shared/db/portfolio-postgres.js`：`read` / `write`（行锁 + 事务）
- [x] T1.9 实现 `accounts`、`saveAccount`、`unlinkAccount`
- [x] T1.10 实现 `fundHoldings`、`saveFundHolding`、`holdsMeta`/`quotes` 写入
- [x] T1.11 实现 `dipFunds`、`setDipReserve`、审计写入
- [x] T1.12 新增 `shared/db/portfolio-runtime.js`，按 URL 选择后端并缓存池
- [x] T1.13 `shared/db/portfolio-bridge.js` 导出全部改为 async
- [x] T1.14 以 ECS 临时库集成脚本验证事务顺序、行锁与 int8 转换（替代伪 client 单测）

### 服务异步化

- [x] T1.15 `stock-manage/src/storage.js` 新增 `createPortfolioBackend(config)` 导出
- [x] T1.16 `stock-manage/src/server.js` 顶层改 async，初始化 backend
- [x] T1.17 转换 `/api/accounts` 系列 8 个路由
- [x] T1.18 转换 `/api/portfolio`、`/api/cash`、`/api/holdings-*`、`/api/pnl`
- [x] T1.19 转换 `/api/trades/review|summary|export`、`/api/quotes/refresh`
- [x] T1.20 转换 `portfolioForRequest`、`openingFundsForAccount`、`tradesForCalculations`、`withRefreshedQuotes`、`backfillSavedTrades`、`recordNamedTrade`、`sendPortfolio`
- [x] T1.21 `trade-routes.js` 3 个路由 async 化
- [x] T1.22 `trade-import-routes.js` 2 个路由 async 化
- [x] T1.23 `qqq-dip/src/store.js` 的 `getCash`/`setCash`/`getLots`/`markExecuted` 改 async
- [x] T1.24 `qqq-dip/src/server.js`、`execution-routes.js`、`execution-plan.js`、`execution-defaults.js`、`monitor.js` 加 `await`
- [x] T1.25 `portal/src/bookkeeping.js` 的 `ledgerForAccount` 改为 async，PG 模式读 `portfolio_users`
- [x] T1.26 `portal/src/bookkeeping-asset-history.js`、`bookkeeping-security-history.js` 增加 PG 读取适配
- [x] T1.27 `portal/src/bookkeeping-trade-history.js` 加 PG 实现
- [x] T1.28 更新组合相关测试为 async
- [x] T1.29 全量跑 `stock-manage`、`qqq-dip`、`portal` 相关测试与 typecheck/build
- [x] T1.30 提交推送

## Phase 2 记账

### PG repository

- [x] T2.1 新增 `portal/src/bookkeeping-postgres.js`：账户读取与余额计算
- [x] T2.2 实现 `saveAccount`、`removeAccount`、`archiveAccount`、`reorderAccounts`、`adjust`
- [x] T2.3 实现 `entries`（筛选、退款关联、余额核对点、`_sqlite_rowid` 排序）
- [x] T2.4 实现 `saveEntry`（退款联动、截图核对点重置、事务）
- [x] T2.5 实现 `removeEntry`、`settings`、`saveSettings`、`savePeriodPreferences`、`saveAnalysisScope`、`saveAutoRates`
- [x] T2.6 实现 `importRows`、`importBalanceAdjustments`、`backup`
- [x] T2.7 新增 `portal/src/bookkeeping-catalog-postgres.js`（初始化、列表、增删改、排序、合并、校验）
- [x] T2.8 新增 `portal/src/bookkeeping-history-postgres.js`（汇率历史、资产快照、证券价格、投资回报）
- [x] T2.9 新增 `portal/src/bookkeeping-qq-postgres.js`（绑定、验证码、事件、位置）
- [x] T2.10 新增 `portal/src/bookkeeping-runtime.js`，按 URL 选择后端
- [x] T2.11 以 ECS 临时库集成脚本验证事务、退款、导入去重与资产历史（替代伪 client 单测）

### 调用方与历史模块

- [x] T2.12 `portal/src/bookkeeping.js` 改用 backend，全部 store/catalog 调用 await
- [x] T2.13 `/state` 中 `historicalFx`、`createAssetHistory`、`securityHistory`、`tradeHistoryReturns` 切 backend
- [x] T2.14 `/import/review|confirm` 中 `reviewIcostImport` 改 async
- [x] T2.15 `/qq` 路由改用 `createQqBookkeeping` 的 async 后端
- [x] T2.16 `bookkeeping-import-review.js` async 化（PG 版本）
- [x] T2.17 `bookkeeping-asset-history.js`、`bookkeeping-historical-fx.js`、`bookkeeping-security-history.js`、`bookkeeping-trade-history.js`、`bookkeeping-qq.js` 增加 PG 分支
- [x] T2.18 `queueSavedTradeHistory` 改 async 队列入口，`stock-manage` 的 `backfillSavedTrades` await
- [x] T2.19 `stock-manage` 的 `/api/accounts/bookkeeping-options` 改用 backend
- [x] T2.20 `stock-manage` 的证券历史价格补全在 PG 模式使用启动时加载的 `verified-backfill` 缓存
- [x] T2.21 `scripts/import-icost.mjs`、`scripts/import-bookkeeping-adjustments.mjs` 支持 backend
- [x] T2.22 更新受影响的记账测试
- [x] T2.23 全量测试 + 提交推送

## Phase 3 qqq-dip 状态

- [x] T3.1 新增 `qqq-dip/src/postgres-store.js`（单行 JSON、串行写入、首次从 JSON 迁移）
- [x] T3.2 新增 `qqq-dip/src/store-runtime.js`
- [x] T3.3 `server.js` 改 `await openStore(config)`，所有 store 调用 await
- [x] T3.4 `execution-routes.js` 11 个路由 async 化
- [x] T3.5 `monitor.js` 轮询与状态更新 await，防重入
- [x] T3.6 `watchCash` 回调 async 化
- [x] T3.7 更新 qqq-dip 测试并全量通过
- [x] T3.8 提交推送

## Phase 4 集成测试与生产切换

- [x] T4.1 新增 `scripts/test-portfolio-postgres.mjs`（临时库全流程）
- [x] T4.2 新增 `scripts/test-bookkeeping-postgres.mjs`
- [x] T4.3 新增 `scripts/test-qqq-dip-postgres.mjs`
- [x] T4.4 在 ECS 运行三个集成脚本并全部通过
- [x] T4.5 部署代码（不设 URL），确认 SQLite 行为与 `/readyz`
- [x] T4.6 备份 `data/navigation.db`（`20261127095008`）与 `qqq-dip.json`
- [x] T4.7 执行 `002-qqq-dip-state.sql`（已修正为 `SET search_path TO navigation`）
- [x] T4.8 切换组合域：portal、portal-background、stock-manage、qqq-dip 设置 `NAVIGATION_PORTFOLIO_POSTGRES_URL` 并重启
- [x] T4.9 浏览器验证股票持仓/账户/交易新增删除/抄底监控
- [x] T4.10 切换记账域：上述进程设置 `NAVIGATION_BOOKKEEPING_POSTGRES_URL` 并重启
- [x] T4.11 浏览器验证记账加载、0.01 账单新增与删除、余额恢复
- [x] T4.12 切换 qqq-dip 状态：设置 `NAVIGATION_QQQ_DIP_POSTGRES_URL` 并重启
- [x] T4.13 浏览器验证 qqq-dip 现金/档位/仓位/操作记录，状态行 88KB 已迁移
- [x] T4.14 确认 SQLite 记账条数、组合 `updated_at`、qqq-dip JSON 不再随已迁数据更新
- [x] T4.15 `pm2 save`，更新文档并提交推送

## 回滚演练

- [x] T5.1 记录删除变量 + `pm2 restart --update-env` 的回滚步骤；SQLite 快照已保留
- [x] T5.2 文档记录「回滚后 PG 写入不自动回流 SQLite」
