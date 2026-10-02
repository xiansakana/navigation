# QQQ 期权记录方案（2026-10-03核验）

## 已落地的修正

- 以行情时间转换出的 America/New_York 日期归属交易日，不使用UTC日期截取。
- 历史错误日期只改标签，保留 original_market_date；不制造缺失的分钟价格。
- 分别保存 requested_at、received_at、captured_at 和行情时间来源。旧数据没有的接收时间留空，不反推。
- 请求前落库 running 状态；请求结束记录成功、重复、失败、过期、非盘中或时间异常。重启时未结束请求记为 interrupted，而非声称成功。
- 报价和成功审计原子写入；重复的到期链不重复写，但每次请求仍有审计。
- 时间差是整链行情时间与接收时间之差，不是各合约的真实事件延迟。
- 当前分钟库拒绝超过30分钟的整链报价、超过1分钟的未来时间、缺失行情时间或非正常交易时段报价。阈值是数据质量防线，不是策略验证结果；收盘摘要独立处理。

## 数据源结论

1. 当前 Cboe 网站报价抓取不是长期方案。其[延时报价表](https://www.cboe.com/delayed_quotes/URI/quote_table/)明确禁止自动提取；不要增频、绕过限制或当作有服务承诺的API。采集审计不等于取得数据存储、使用或再分发许可。
2. Alpaca [历史期权数据文档](https://docs.alpaca.markets/us/docs/historical-option-data)说明历史覆盖自2024年2月起，免费 indicative 报价是原OPRA的修改/派生报价，不能混入真实报价执行回测。订阅OPRA后再核验历史quote查询权限、限额和保留许可。
3. ThetaData [历史quote接口](https://docs.thetadata.us/operations/option_history_quote.html)支持到期日、日期、行权价和时间间隔；[订阅页](https://www.thetadata.net/subscribe)当前列出 Value $40/月、Standard $80/月、Pro $160/月。Standard列出8年历史、tick和NBBO。开户前需确认QQQ、到期合约历史、Greeks、批量范围、下载/长期保存授权与实际套餐；没有购买或配置账户。
4. Moomoo [API接口目录](https://open.moomoo.com/api/overview/api-reference)和[订阅接口](https://open.moomoo.com/api/quote/push/subscribe)提供期权链与推送相关能力。若已有账户，先核实美股期权报价权限、报价深度、订阅额度及历史数据范围。成交K线不能替代bid/ask；不要假设已到期合约都可回补。
5. IBKR明确[不提供已到期期权市场数据](https://www.interactivebrokers.com/campus/trading-lessons/requesting-market-data/)，因此即使实时记录可用，也不宜作为过期后补漏的唯一来源。

## 推荐架构（尚未接入新来源）

主源选择具有授权与历史quote权限的供应商。使用独立PM2/systemd采集进程，和网页服务分离，避免回测或期权链查询占用采集事件循环。独立进程要增加单实例租约，不能让多个进程同时恢复/写同一请求。共享用户数据仍按Portal用户隔离。

同时做三件事：

- 实时流：订阅bid/ask及大小、事件时间、序号、标的价格；last/trade单独记录。源数据获准保留时，保存原始事件或可重放日志。
- 分钟校验：生成覆盖清单，关键的09:30、09:45和退出阶段单独标记；缓存重复、断网、429、暂停、重启各有状态。交易日/提前收盘采用交易所日历，不仅检查周一至周五。
- 历史补漏：重连后与每天收盘后，从同一授权来源拉取缺失quote区间，携带 historical-backfill 标记和获取时间。延时源要在正常收盘后保留延时缓冲。原采样记录保留，补回数据不冒充当时已知信息。

每个合约事件建议去重键为来源、合约、事件时间和供应商序号；没有序号时需保留载荷哈希，不能只用分钟时间去重。生产按日归档到Parquet/对象存储，SQLite保留近期数据和索引，避免同一业务库无限增长。

## 回测边界

信号的09:30标的开盘价应来自可验证的股票分钟数据，不能将09:35的第一条链价格称为09:30开盘价。期权退出仍用bid，入场用ask；滑点、报价大小和事件间缺口需要保守规则。历史回补可做事后研究，不能证明在延时报价接收之前能实时成交。没有真实bid/ask的区间不插值，不将indicative或模型价格混为实盘报价。

下一步需用户确定数据源、预算和账户权限；不自动购买订阅、不索取聊天中的API密钥、不未经许可公开再分发行情。
