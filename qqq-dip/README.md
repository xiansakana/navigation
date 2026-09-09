# 抄底监控（qqq-dip）

QQQ / 指数 ETF 与期权的开盘监控、操作推荐、双币种弹药与 QQ 提醒。与 `stock-manage` 持仓服务**独立进程、独立数据库**，互不改对方数据。

规则来自 `public/docs/` 内嵌手册（源文件在仓库旁的 `qqq-dip-playbook`）。页内可点「手册速查」「操作手册」预览。更新 playbook 后同步：

```bash
cp ../qqq-dip-playbook/抄底手册速查.md public/docs/cheatsheet.md
cp ../qqq-dip-playbook/抄底分析报告与操作手册.md public/docs/manual.md
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
| `finnhubApiKey` | 股票/日线/VXN |
| `polygonApiKey` | 期权 snapshot 与 LEAP 合约列表 |
| `notify.qq.url` | 默认 `http://127.0.0.1:8787/notify` |

弹药 **B** = 美元现金 + 人民币现金 / 手填汇率。不计入持仓总资产。

正股执行顺序：优先用人民币买场内 **159509**（纳指科技ETF景顺），再用美元买 QQQ；期权只用美元。标记档位已执行时按填写金额扣减对应币种现金。

## ECS

```bash
cd /opt/navigation/qqq-dip
./deploy-ecs.sh
```

`ecs-update.sh --only qqq-dip`
