# 抄底监控（qqq-dip）

QQQ / 指数 ETF 与期权的开盘监控、操作推荐、双币种弹药与通知。与 `stock-manage` 独立进程，但**共享现金与真实交易账本**；执行登记会扣现金并同步持仓，不能重复录单。监控轮次与止盈登记仍单独存储，目前为单一所有者服务。

规则来自 `public/docs/` 内嵌手册（源文件在仓库旁的 `qqq-dip-playbook`）。页内可点「手册速查」「操作手册」预览。更新 playbook 后同步：

```bash
cp ../../qqq-dip-playbook/抄底手册速查.md public/docs/cheatsheet.md
cp ../../qqq-dip-playbook/抄底分析报告与操作手册.md public/docs/manual.md
```

不是投资建议。

## 本地

```bash
cd qqq-dip
cp config.example.json config.json
# 填入 finnhubApiKey / polygonApiKey，QQ token 与 qq-bot 一致
npm install
npm test
npm start
```

http://127.0.0.1:5001

Portal 反代路径：`/stock-manage/dip/`（持仓页顶部 Tab 进入）。

## 配置

| 字段 | 说明 |
|------|------|
| `server.port` | 默认 `5001` |
| `dbPath` | 默认 `data/qqq-dip.db`（实际写入同名 `.json`，与持仓库隔离） |
| `finnhubApiKey` | 股票/日线；VXN 当前为 FRED 日收盘优先、Yahoo 回退 |
| `polygonApiKey` | 期权 snapshot 与 LEAP 合约列表 |
| `notify.qq.url` | 默认 `http://127.0.0.1:8787/notify` |

页面 **B（B₀）** 为本轮固定预算，启动时按美元现金 + 人民币现金/汇率锁定；与当前现金余额分开。买入后不缩小后续档位预算，轮内回款/追加资金不扩大比例。轮次启动同时固定参考高点及策略比例；重置后重新计算。旧轮次按余额＋已登记投入估算迁移，存在出入金时须核对。

操作顺序与数据限制见 [操作手册](public/docs/manual.md) 文首。信号/通知/预览不代表券商成交；VXN 来源、期权报价新鲜度、资金上限及拆合股交割需人工确认。通知统一在 Portal 通知管理设置，开盘摘要默认关闭，启用后纽约交易日 09:35 起检查。

正股执行顺序：优先用人民币买场内 **159509**（纳指科技ETF景顺），再用美元买 QQQ；期权只用美元。标记档位已执行时按填写金额扣减对应币种现金。

## ECS

```bash
cd /opt/navigation
# 本地测试、提交并推送后，在 ECS 干净工作区拉取并核对完整 SHA
git pull --ff-only origin main
./scripts/ecs-update.sh --expected-sha <full-commit-sha> --only qqq-dip
```

只部署已核对的 Git 提交，不直接编辑或 SCP 覆盖生产代码。
