# 公司监听：申请与经营提醒

入口 `/torn-toolbox/company/`，原页面归入“申请”Tab；新增“扣工资”“员工训练”“库存”。申请的账号、数据、原通知设置及启停逻辑保留。

经营提醒通过原申请中已启用账号选择，不向浏览器返回 Key，保存时复制已选账号的 Key 到该 Portal 用户的 SQLite 配置。原公司账号 Key 后续变更后，请重新选择并保存经营提醒。每个用户独立保存条件、通知设置、历史及去重。三个新功能默认关闭，需保存并单独启动经营提醒；保存任一配置会停止经营提醒，其余 Tab 条件保留。申请监听不受影响。

- 扣工资：last_action.timestamp 距今严格超过所设天数时提醒（默认 3 天），同一员工同一次离线只提醒一次。未知或未来时间不推断离线。仅提醒检查工资，不操作工资。
- 员工训练：默认提前 2 小时，以每天 18:00 TCT（UTC）为预期结算。预测现有 trains + rating > 20 时提醒，如 9★、12/20 预计溢出 1 次。每个结算日提醒一次；18:00 后窗口归于下次结算。额外 Trainer 岗位等收益不计入，星级或结算延迟会影响预测。
- 库存：各商品 in_stock 之和除以 profile.upgrades.storage_capacity，严格高于上限或低于下限时提醒（默认 95% / 5%）。不计 on_order。正常后再次越界可重新通知。无 stock 商品的服务型公司不提醒；缺少容量或数量时报错，不把缺失值当成零。

数据来自官方 `/v2/company/profile`、`/v2/company/employees`、`/v2/company/stock`，建议使用公司董事的 Limited（或包含对应 selections 的 Custom）Key。新请求经过 `torn-monitor-worker` 既有账号共享限速，默认 2 秒/账号，与其他监控共用额度；一轮默认 60 秒，允许 30–3600 秒。每轮每账号复用 profile，工资与库存各增加一个数据请求。网络与限流沿用共享重试，错误展示在对应项。关闭浏览器不停止，服务重启恢复已保存运行意图。

渠道、目标、@ 与测试统一在“通知管理 → 业务提醒”中三个独立的公司经营提醒卡片配置，默认关闭。原“公司申请”卡片原样保留。通知包含公司链接，离线提醒另包含员工 profile 链接。保存事件与去重后才投递；历史最多 200 条。投递失败显示错误，不自动重发，避免重复；不保证进程中断时恰好一次投递。

SQLite 表 `torn_company_alerts` 按 Portal user_id 隔离；模块权限 `torn-company-alerts:*` 在权限管理注册，三个 Tab 各自有查看、编辑、通知查看/保存/测试权限；选择已有账号还要求原 `service:torn-company:edit`。只读数据范围不可编辑，未授权不能通过直接调用 API 修改。配置/控制/数据范围由 Portal 与 worker 两端检查。

参考：[官方 API schema](https://www.torn.com/swagger/openapi.json)，[官方 Company Wiki](https://wiki.torn.com/wiki/Company)。Wiki 说明训练按星级每日获得、上限 20，结算约 18:00 TCT，实际更新可延后。
