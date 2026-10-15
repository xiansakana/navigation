# 股票数据按用户隔离

股票交易、现金、用户持仓行情缓存和持仓备注存入共享 SQLite 的 `portfolio_users`，以 Portal 的 userId 为唯一归属。汇率来源和旧抄底现金迁移标记使用 `portfolio_user_meta(user_id,key)`。同一交易 ID 可在不同用户内存在，替换导入、删除和修改只影响当前用户。

股票 API 必须收到 Portal 注入的有效用户 ID；缺少身份返回 401。Portal 会删除外部伪造身份头，再注入真实 session 身份；股票和抄底服务必须仅监听 loopback，不能直接暴露到公网。查询参数、请求体、导入文件中的 userId 不参与归属。API 响应禁止缓存。AsyncLocalStorage 保留异步请求身份，不使用可被并发请求覆盖的全局当前用户变量。

新用户默认空持仓、零现金，没有旧全局数据回退。旧数据不按首个访问者自动认领，也不复制给所有管理员。维护脚本必须显式提供 `--user-id`。

## 一次性迁移

先核对实际登录用户与 RBAC 用户 ID。停止 `stock-manage`、`qqq-dip`，防止旧进程在复制后继续写全局表；从已验证提交执行：

```sh
cd /opt/navigation/stock-manage
node scripts/migrate-user-portfolio.mjs --user-id <真实用户ID>
node scripts/migrate-user-portfolio.mjs --user-id <真实用户ID> --apply
```

应用前创建权限 0600 的股票数据 JSON 快照，不含无关行情历史表。迁移在 SQLite immediate 事务内保存完整旧状态并核对；目标已有数据则拒绝覆盖。`meta.portfolio_legacy_owner` 标记唯一归属，同一用户重复执行无副作用，更换用户再次执行则拒绝。旧全局表保留作核对备份，迁移后旧存储写接口拒绝写入。

抄底模块的轮次、仓位、动作与通知当前仍为单用户设置，因此其私人 API 仅允许迁移的原用户访问，其他用户返回 403；自动监控后台明确使用该原用户的股票现金与交易，不能回退为任意访问者。股票模块本身支持每位用户独立使用，抄底多用户轮次不在本次范围。

完成迁移后以 `scripts/ecs-update.sh --expected-sha <sha> --only portal,stock-manage,qqq-dip` 重启关联服务。检查原用户交易/现金/备注完整、新用户为空、越权交易 ID 修改/删除失败、匿名请求 401、导入/导出/复盘仅含本人记录、Portal 忽略伪造身份头。

验证：股票管理完整 npm test（含真实 HTTP API 隔离测试）、抄底完整 npm test、Portal RBAC 测试。维护示例：`node scripts/fix-dividend-tax.mjs --user-id <用户ID>`、`node scripts/backfill-trade-names.mjs --user-id <用户ID> --apply`。
