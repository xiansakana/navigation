# 记账模块

首页服务列表提供记账入口，收支概览仅在 `/bookkeeping/` 内展示，首页不请求账单数据。完整页面由 Portal 自身提供，不需新增进程或反向代理。支持 PC 分栏及手机底部导航、深浅主题、明细筛选/分页、记一笔/编辑/删除、分类与每日收支、CNY 月预算、资产分组、多币种账户、信用额度/账单日/还款日、余额调整、iCost XLSX 导入预览与导出。

## 权限和存储

权限集中定义于 `portal/src/rbac.js` 的 `bookkeeping:*` 条目，包含查看、账单编辑、资产查看/编辑、导入、导出、预算和汇率设置。每一项含首页下的 permissionPath。管理员自动获得权限，普通用户由管理员分配；游客无法访问。页面、API 和首页均检查权限。SQLite 的三张 bookkeeping 表按 Portal userId 隔离，客户端提交的用户 ID 不参与数据归属。

## 迁移口径

- iCost 查看用导出没有完整资产初始余额与余额调整历史，不可直接累加还原资产。历史导入记录 `affects_balance=0`；截图账户余额为初始基准，之后手工新增的记录联动余额。修改或删除历史导入账单不改变基准，应通过“核对余额”调整。
- 账户快照 JSON 可在导入界面附带上传，仅创建尚不存在的账户；已有账户余额不会被覆盖。快照数组字段为 `name, group, currency, balance, included, creditLimit, billDay, dueDay, note, snapshotAt`。负余额表示负债；不计入账户在原币和折算总资产中均排除。
- 跨币种历史转账只有一个金额，无法还原到账额。保留原币和原始字段，新跨币种转账必须明确到账额。汇率统一表示一个原币兑换多少 CNY；自动、手动和缓存均缺失时不显示折算总数。
- 支出/已报销计入支出；退款入账/报销入账冲减支出；收入计入收入。转账/还款/借出/收回/余额调整不计入收支，手续费计入支出。原单的退款与优惠是辅助信息，不再次冲减。
- 导入按字段内容哈希和相同行出现次数去重，重复上传不会重复记账；内容修改后重新上传属于新记录，请在页面中编辑原记录。错误行会阻止整个导入，不静默丢弃。预览只存内存，15 分钟失效，按用户绑定。
- 导入保留原始行和图片来源链接作为私有数据，不自动访问远程图片。XLSX 导出使用 iCost 列顺序，供查看和迁移，不包含原始图片链接、跨币种到账额或账户余额，不能视为完整备份或承诺能恢复到 iCost。

CLI 可在明确指定用户后导入，个人文件不得进入 Git：

```powershell
node scripts/import-icost.mjs --user admin --file '<iCost.xlsx>' --accounts '<accounts.json>' --dry-run
node scripts/import-icost.mjs --user admin --file '<iCost.xlsx>' --accounts '<accounts.json>'
```

## 验证和部署

运行 `node --test portal/src/*.test.js` 和 stock-manage 的 `npm test`。共享汇率服务变更需部署 portal、stock-manage；表结构首次调用 API 或 CLI 时创建，不影响已有表。先验证 origin/main SHA，ECS 清洁且 `git pull --ff-only` 后执行 `scripts/ecs-update.sh --expected-sha <sha> --only portal,stock-manage`。个人迁移通过 CLI 显式指定用户，不在应用启动时自动导入，文件留在受保护的私有运行目录。

## 自动参考汇率

股票管理的 USD/CNY 与记账共用 `shared/foreign-exchange.js`，按 Finnhub → FRED → Yahoo 回退。记账从股票管理的本机私有配置读取 Finnhub Key，密钥不返回浏览器。CNY 固定为 1；USD/HKD/JPY/MYR/EUR/GBP/SGD 自动获取。Finnhub 用 USD 基准报价计算交叉汇率；FRED 用同日 DEXCHUS 与各币种 H.10 观测计算，EUR/GBP 的序列方向与其他币种相反，禁止跨日期混算。Yahoo 用原币/CNY 货币对兜底。数据为参考值，FRED 为日频观测，并非实时兑换成交价。

进入记账页面后台加载汇率，不阻塞账单。资产按有效参考汇率自动折算，统计与资产页面展示来源、数据日和获取时间。手动“更新参考汇率”使用 `bookkeeping:fx:edit` 权限；60 秒缓存合并并发请求与失败退避。自动结果按 userId 保存在现有 bookkeeping_settings 中，修改预算或手动值不会抹除它。自动失败时优先手动备用值，随后上次成功值，后者显示历史缓存标记。超过一小时未重新获取的数据、重启后更新失败的数据均标记历史缓存；无法获取且无备用值时明确显示缺失。浏览器返回的来源/状态不含供应商密钥或底层错误详情。

FRED 口径参考：[HKD](https://fred.stlouisfed.org/series/DEXHKUS)、[JPY](https://fred.stlouisfed.org/series/DEXJPUS)、[MYR](https://fred.stlouisfed.org/series/DEXMAUS)、[EUR](https://fred.stlouisfed.org/series/DEXUSEU)、[GBP](https://fred.stlouisfed.org/series/DEXUSUK)、[SGD](https://fred.stlouisfed.org/series/DEXSIUS)。
