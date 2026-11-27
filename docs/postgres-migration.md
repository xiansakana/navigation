# Navigation PostgreSQL 迁移

## 数据导入演练

`scripts/rehearse-postgres.py` 从 SQLite 只读事务读取同一时点的数据，流式写入 PostgreSQL 17 的新 `navigation_rehearsal_*` schema。它保留整数、浮点数、文本、BLOB、NULL、SQLite 行号和自增高水位，并按行号复读 PostgreSQL 数据，核对逐表行数和内容摘要。任何一步失败会回滚整个 schema。重复使用已有 schema 会报错。

使用独立数据库和可创建 schema 的演练账号，连接信息通过 libpq 服务配置提供：

```bash
python -m pip install 'psycopg[binary]==3.3.9'
PGSERVICE=navigation-rehearsal python scripts/rehearse-postgres.py \
  --sqlite /path/to/navigation.db --schema navigation_rehearsal_trial1
```

演练表的 `_sqlite_rowid` 保留旧数据的排序依据，`sqlite_sequence` 保留自增高水位，`_sqlite_schema` 保存原始表、索引和触发器定义。演练报告只输出汇总数量，目标数据库包含完整业务数据，应按生产数据控制访问。

## 生产目标库

`shared/db/postgres/compose.yml` 运行持久化 PostgreSQL 17，监听 ECS 本机 `127.0.0.1:5432`。启动前在服务器的 `/opt/navigation-postgres/postgres-password` 保存随机数据库管理员密码，文件权限为 600。使用 `docker compose -f shared/db/postgres/compose.yml up -d` 启动。数据库连接经过 SSH 隧道或服务器本机，使用 SCRAM 密码认证。

以迁移账号连接目标 PostgreSQL 时，执行：

```bash
PGSERVICE=navigation-target python scripts/rehearse-postgres.py \
  --baseline --sqlite /path/to/navigation.db --schema navigation
```

`--baseline` 应用版本化 DDL，保留业务主键、约束、索引及 RBAC 版本触发器。目标库按实际记录和 SQLite 的自增高水位初始化 PostgreSQL 序列。迁入后逐表核对行数及内容。目标 schema 必须为空且由导入命令创建，表名、列名或类型漂移会导致整个事务回滚。

从生产在线快照初始化的目标库可用于兼容性和 Navicat 只读验证；快照时间之后的生产写入仍进入 SQLite。正式切换使用停写后得到的快照，并按 [应用切换条件](#应用切换条件) 验收。

## 应用读写适配

Portal 的命理个人案例已接入异步 PostgreSQL 查询和事务。独立验证环境通过 `NAVIGATION_MINGLI_POSTGRES_URL` 选择 PostgreSQL。此配置仅接管命理的个人案例、分类和问真导入，排盘仍在应用内计算，知识库案例仍依赖现有知识库。正式全站切换前生产不启用这一独立配置。

GitHub Actions 使用 PostgreSQL 17 执行命理 HTTP 集成测试，覆盖访客拒绝、不同账号的数据隔离、分类约束、条件筛选、批量归类及并发导入。待其余业务适配后再执行全站切换。

隔离环境的 Portal 和 `portal-background` 同时设置 `NAVIGATION_BLOG_POSTGRES_URL`，可验证博客、评论、旧媒体记录、视频分片和媒体清理共用同一数据库。对象存储和临时视频文件继续沿用既有路径。视频编码与清理维持单个后台工作进程的部署方式。

资源管理通过 `NAVIGATION_RESOURCES_POSTGRES_URL` 验证模块计数和任务状态，响应只包含聚合指标。同一个 Portal 进程中接到相同数据库的模块复用连接池。

隔离环境通过 `NAVIGATION_TORN_POSTGRES_URL` 验证 Torn 用户监控、扫货助手、帮派摧毁监控、帮派筛选、公司提醒、压价监控的断点、通知设置和提醒去重，以及工作器心跳和启停意图。独立公司管理的既有文件型状态由公司工作器保存。

`NAVIGATION_QQ_MONITOR_POSTGRES_URL` 用于隔离验证 QQ 登录监控、重启冷却记录、Codex 登录告警去重和工作器心跳。Codex PostgreSQL 仓库已通过隔离测试，覆盖会话 API、任务进度、Web 与 QQ 入队、并发领取、队列上限、执行中断以及结果和回执原子写入。上线前仍需让待办、QQ 消息入口、会话 API 的生产配置与工作器统一使用这套存储。

股票服务通过 `NAVIGATION_QUANT_POSTGRES_URL` 验证量化设置、模拟盘和回测记录的读写。量化状态使用同一账号行锁串行更新，行情请求在事务外完成。实盘组合、记账关联和抄底资金仍须完成迁移。

知识库的 PostgreSQL 仓库已覆盖设备、租约、上传、导入、115 归档队列、笔记读写、版本恢复和公开浏览。隔离测试涵盖容量并发、分片重传、下载任务接管、编辑版本冲突、跨账号访问、公开投影字段和工作器从配对到发布笔记的 HTTP 路径。批量导入队列、生产 HTTP、调度和 115 归档工作器通过 `NAVIGATION_KNOWLEDGE_POSTGRES_URL` 与文档、租约和扫码账号共用同一数据库；隔离测试同时覆盖批量队列领取、容量回退、失败重试与删除，以及 Portal 就绪检查。未配置该变量时知识库继续使用 SQLite。

隔离环境可用 `NAVIGATION_RBAC_POSTGRES_URL` 为 Portal 选择 PostgreSQL 身份源。密码与 OAuth 登录、角色和数据策略管理、数据空间、以及 Portal 访问审计使用这一来源。真实 Portal 集成测试覆盖密码登录、撤权、已有会话和跨用户范围访问。QQ Codex 命令、任务执行与回执，以及已经适配的 Torn 监控也读取这个身份源。迁移文件包含数据库版本标记，Portal 在已配置的数据库不可用或版本不匹配时报告未就绪。SQLite 数据库入口拒绝全站 PostgreSQL 配置，防止切换时静默写入 SQLite。

## PostgreSQL 备份与恢复

在备份机器安装与 PostgreSQL 服务端同版本的 `pg_dump`、`pg_restore` 和 `psql`。全站切换后，为现有 115 备份任务配置 `NAVIGATION_DATABASE_ENGINE=postgres` 和 `NAVIGATION_POSTGRES_BACKUP_SERVICE`，由 libpq 服务配置提供连接。备份账号需可读 `navigation` 下的表及序列。数据库使用事务一致的 `pg_dump` 自定义格式，备份任务继续用既有加密和上传验证流程。

解密归档后，在独立实例预先建好一个空的 `navigation_restore_*` 数据库，通过 `python scripts/backup-navigation.py --verify ARCHIVE --restore-postgres-service SERVICE` 核对归档和恢复。恢复使用单一事务。应用数据库账号和授权由部署配置重新建立。

## 生产启用现状

生产 `navigation` 数据库已按 `001-initial.sql` 初始化并完成 SQLite 基线导入（85 张表、1,823,116 行，逐表行数与内容校验通过）。以下模块通过模块级连接变量接入同一数据库：

| 变量 | 使用进程 |
| --- | --- |
| `NAVIGATION_RBAC_POSTGRES_URL` | portal、portal-background、codex-worker、qq-bot、torn-monitor-worker |
| `NAVIGATION_MINGLI_POSTGRES_URL` / `NAVIGATION_BLOG_POSTGRES_URL` / `NAVIGATION_RESOURCES_POSTGRES_URL` / `NAVIGATION_KNOWLEDGE_POSTGRES_URL` | portal、portal-background、codex-worker |
| `NAVIGATION_TORN_POSTGRES_URL` / `NAVIGATION_TORN_USERS_POSTGRES_URL` | portal、torn-monitor-worker |
| `NAVIGATION_QQ_MONITOR_POSTGRES_URL` | qq-bot |
| `NAVIGATION_QUANT_POSTGRES_URL` | stock-manage |

`knowledge-storage-worker` 通过 `/etc/navigation/postgres.env` 读取知识库连接变量。记账、实盘组合、抄底资金和 `qqq-dip` 已于 2026-11-27 完成迁移并切换到 PostgreSQL；仍未设置 `NAVIGATION_DATABASE_ENGINE=postgres`，各模块继续通过独立变量选择 PostgreSQL，未设置时回退 SQLite。

四个模块使用以下模块级变量：

| 变量 | 覆盖范围 | 使用进程 |
| --- | --- | --- |
| `NAVIGATION_PORTFOLIO_POSTGRES_URL` | 实盘组合、投资账户、基金持仓、行情快照、抄底资金预留 | portal、stock-manage、qqq-dip |
| `NAVIGATION_BOOKKEEPING_POSTGRES_URL` | 记账账本、分类分组、资产历史、汇率历史、证券价格历史、记账 QQ | portal、stock-manage |
| `NAVIGATION_QQQ_DIP_POSTGRES_URL` | `qqq_dip_state` 单行状态文档 | qqq-dip |

抄底资金在组合写入事务内维护，必须随 `NAVIGATION_PORTFOLIO_POSTGRES_URL` 一起切换，不单独配置变量。

`qqq_dip_state` 属于 PostgreSQL 专有表，由 `shared/db/postgres/002-qqq-dip-state.sql` 幂等创建，不写入 `001-initial.sql`，也不提升 `navigation_schema_migrations` 的版本；SQLite 基线导入只比对 SQLite 快照中真实存在的表。执行方式：

```bash
docker exec -i navigation-postgres-postgres-1 psql -U navigation_db_admin -d navigation \
  < shared/db/postgres/002-qqq-dip-state.sql
```

实际切换顺序：先部署代码（不设置变量）并确认 SQLite 正常；备份 `data/navigation.db` 与 `data/qqq-dip.json`（快照时间 `20261127095008`）；执行 002；portal、portal-background、stock-manage、qqq-dip 同批设置组合变量并重启；上述进程再加上记账变量并重启；最后为 qqq-dip 设置状态变量并重启。每批切换后检查 `/readyz`、`/api/health` 和页面数据，最后 `pm2 save`。

切换完成后验证：

- `scripts/test-portfolio-postgres.mjs`、`scripts/test-bookkeeping-postgres.mjs`、`scripts/test-qqq-dip-postgres.mjs` 在 ECS 上使用临时数据库（`navigation_test_*`）全部通过，覆盖组合写入、账户绑定、抄底预留、记账退款、导入去重、资产历史、汇率/证券价格、QQ 状态与 qqq-dip 重启恢复。
- 浏览器实测记账新增/删除 0.01 账单后余额恢复；股票新增/删除 1 股 QQQ 交易后现金与交易数恢复；抄底监控现金、档位、仓位、操作记录正常。
- 切换后 SQLite 中 `bookkeeping_entries` 仍为 3,731 条、`portfolio_users.updated_at` 停留在切换前、`qqq-dip.json` 不再更新，证明已迁数据不再写 SQLite。

回滚时删除对应进程的上述变量并执行 `pm2 restart <进程> --update-env`，随后 `pm2 save`；systemd worker 移除 `/etc/systemd/system/knowledge-storage-worker.service.d/postgres.conf` 后重启。SQLite 数据文件和 `config.json` 在切换过程中保持原样，删除变量即可回到 SQLite 读写。切换后写入 PostgreSQL 的新数据不会自动回流 SQLite，回滚前需人工核对。切换前的 SQLite 一致性快照位于 `data/navigation.db.bak-20261127095008`（qqq-dip JSON 同目录同名 `.bak-20261127095008` 若存在）。

## 应用切换条件

运行时需要 PostgreSQL 连接池，以及将 Portal、后台队列、股票、抄底和 QQ 业务改为异步数据库读写。

生产模式使用 `NAVIGATION_DATABASE_ENGINE=postgres`、`NAVIGATION_POSTGRES_URL` 和 `NAVIGATION_POSTGRES_DATABASE`。服务共用同一个目标库，连接检查核对数据库名称和 schema 版本，并验证应用角色具有读写业务表及使用序列的权限。历史模块连接变量继续用于隔离演练。生产开启前需清除与统一连接不一致的模块配置，并完成所有服务的 SQLite 禁用运行验证。

- 明确每处 `rowid` 排序和游标的业务顺序，给迁入和新增记录分配连续可比较的键。将 SQLite 序列值用于初始化 PostgreSQL 自增序列。
- 将 RBAC 版本更新、账务事务、上传配额和任务领取迁移到 PostgreSQL 的事务与锁机制。对并发读取、写入、回滚和跨用户数据隔离做 PostgreSQL 集成测试。
- 建立 PostgreSQL 备份并验证实际恢复，更新 ECS 服务的启动与健康检查。单独保留 SQLite 一致性备份以支持正式切换前回退。
- 上述检查通过后，在停写窗口导入最终快照并验证记录数、归属和关键业务行为，再切换应用连接。恢复生产写入后，回退前需处理 PostgreSQL 中新增的写入。

维护窗口开始前，确认源站 HTTPS 已由 `scripts/sync-blog-upload-nginx.py` 安装维护开关。创建 `/run/navigation/maintenance` 并确认公网 HTTPS 返回 503，再停止所有业务写入。维护期间从 ECS 本机访问 Portal 的回环端口执行就绪和业务验收。允许业务恢复写入后移除标记，通过公网验证首页、登录及核心 API。
