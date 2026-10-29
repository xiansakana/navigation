# Torn 监控工作器

生产单实例 `torn-monitor-worker`（`scripts/torn-monitor-worker.mjs`）承载扫货、帮派摧毁、帮派筛选、公司监听和压价助手。Portal仍负责页面、登录、RBAC、数据范围、API入口和转发。通知开关、渠道、目标、@和测试全部保留在“通知管理 → 业务提醒”，原配置不迁移、不清空。

## 运行边界

- 控制端口仅绑定127.0.0.1:8792，不开放公网。Portal转发带签名的请求，包含请求方法、路径、作用域会话、正文、时间和随机数；校验HMAC、30秒有效期和防重放。使用从现有会话密钥派生的专用签名密钥，不在请求中发送会话密钥。
- Portal先检查身份、RBAC和数据范围，再转发；worker继续执行原接口权限、同源和后台权限检查。worker不可用返回503，不回退到Portal启动第二份扫描。开发环境未开启runtime.tornMonitorWorker时仍可在Portal本地运行。
- 公司监听8791、压价助手8790的HTTP/SSE服务和扫描器都在同一worker进程，沿用原入口、Portal代理鉴权、账号配置及中央通知事件协议。原torn-company/torn-undercut PM2进程迁移后删除，不得同时运行。
- 五类任务共享官方API客户端，按key/info确认Torn账号，同账号所有Keys共用串行通道，使用该账号活跃任务中最长的请求间隔；公司/压价的默认请求间隔2秒。巴扎共享Weav3r串行队列（至少2秒）。不通过换Key规避限流，保持限流冷却和有界重试。

## 持久化与恢复

`torn_monitor_runs`按module/user_id保存前三类任务的运行意图。成功启动记为运行，手动停止、保存扫描配置或重置记为停止；权限撤销/致命错误停止后记下错误并撤销恢复意图。退出worker时停止内存扫描但保留运行意图，下次启动仅恢复此前应运行且仍有权限的任务。缓存、去重和帮派筛选进度仍使用原SQLite表；轮次计数等内存统计会重置，正在进行的未完成扫描重新执行。

公司监听沿用autoStart和原持久化申请去重。压价助手启动/停止同步autoStart，在SQLite新增torn_undercut_runtime保存每个watcher的活跃压价与提醒，按API Key指纹校验兼容性。迁移首次快照来自旧服务当前可见压价列表（最多100条）。后续运行直接保存完整活跃集合，不受此迁移读取上限影响。通知仍按原去重策略，不承诺跨通知投递与数据库写入的分布式exactly-once。

## 部署

首次执行：

```bash
bash scripts/ecs-update.sh --expected-sha <已推送SHA> --only torn-monitor-worker,portal
```

迁移先读取原生任务和两项旧服务的实际启停状态；持久化运行意图、停止旧Portal扫描，并把公司/压价的实际状态写回autoStart。随后停止旧Portal/两个旧服务进程，启动worker、校验健康，删除旧PM2记录，再启动Portal。已有业务条件、Keys、历史和通知设置保留。部署前可运行 `node scripts/migrate-torn-monitor-worker.mjs` 只读预检（未传--apply）。迁移涉及短暂访问中断，不自动回退并行启动旧监控。

后续 `--only portal` 不重启worker；修改五类扫描实现时显式 `--only torn-monitor-worker`（如也改Portal则一起部署）。`--only company` / `--only undercut` 已迁移后等价更新整个worker，五类任务会一起恢复。PM2使用35秒kill_timeout，worker收到信号取消扫描、等待在途请求、关闭HTTP后退出；异常退出由PM2拉起，继续恢复应运行任务。

验收需确认：五类状态/既有权限正常；无旧公司/压价进程；worker重启后运行任务恢复、停止任务不启动；单独重启Portal后worker PID与轮次保持；通知记录和配置保留；无签名控制请求403、未授权Portal请求拒绝。健康检查只读，不发送测试通知。`verify-platform.mjs`在启用worker时增加其健康检查，资源页显示新的运行归属与心跳。

回滚时先停止worker，确认原生扫描已取消后再停用runtime.tornMonitorWorker并启动旧服务/Portal。不要同时启动新旧扫描器。新增SQLite表可保留，不删除原业务表。
