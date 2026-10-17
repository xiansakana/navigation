# QQ Codex 移动入口

QQ私聊与授权群指令通过已鉴权的NapCat WebSocket进入现有qq-bot，校验QQ白名单和Portal权限后，调用服务器已登录的Codex CLI。沿用CLI账号登录与代理，不另外配置模型API。参考 [Codex非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)。

此功能只通过Git同步代码、已跟踪的根目录及子目录`AGENTS.md`；不向电脑同步会话、任务状态、CLI登录缓存、数据库或上传资料。QQ自己的会话可以连续使用，也可显式新建。

## 使用

接受授权用户私聊，或在已配置群中真实@机器人后发送的`codex`、`/codex`前缀指令。未授权群、未授权发送人、没有@的群消息、普通聊天和附件不会触发执行。

```text
codex 帮助
codex 项目
codex navigation 检查知识库的最近修改，运行相关测试并修复问题
codex 继续上一项任务
codex 状态
codex 结果
codex 停止
codex 同步 navigation
codex 新会话 navigation
```

新会话不会删除已有代码。任务按队列逐个执行，最多5个等待或执行中的任务。回复较长时分段发送，`codex 结果`可以重新读取最近结果。QQ回执失败会退避重试；极端情况下发送后落库前中断可能出现重复回执，但同一入站事件不会重复创建任务。

## 通知管理中的群聊配置

打开 `/notifications/` 的「QQ Codex 群聊」区域，每行填写一个允许的群号（最多20个），选择完整结果发送到「私聊发起人」或「原群并@发起人」，点击「保存群聊配置」，立即生效。留空并保存会关闭群聊入口，不影响私聊。机器人需要已加入该群；填写群号不会自动加群。

设置保存在共享SQLite的`qq_codex_settings`，只属于当前Portal用户。需要执行权限、查看设置权限`qq-codex:settings:view`与保存权限`qq-codex:settings:edit`，权限目录为「首页→通知管理→QQ Codex」。此页面不允许更改执行账号、项目目录或CLI凭据。API为Portal自有`/api/qq-codex/settings`，按登录身份取用户ID，并校验跨站写入。

默认完整结果私聊，群内仅显示接收和完成状态。选择原群时，群成员均可看到模型结果；关闭群结果后，尚未投递的完整结果改发私聊。移除群会阻止后续指令、领取和群回执，并停止该群正在执行的任务。重新添加群后可以续接原群会话。

会话、历史结果、状态和停止操作按「用户＋项目＋群」隔离，私聊原会话保持不变。群A的`codex 结果`不会读取私聊或群B历史；群内`codex 停止`只取消发送人当前群的任务。代码仍使用授权项目的同一个Git开发检出，并按原有全局队列串行执行。

## 私有配置

在`qq-bot/config.json`配置（权限600，不提交Git；公共设置接口不暴露或修改此段）：

```json
{
  "codex": {
    "enabled": true,
    "binary": "/usr/bin/codex",
    "proxyUrl": "http://127.0.0.1:17890",
    "sandbox": "danger-full-access",
    "defaultProject": "navigation",
    "timeoutMs": 7200000,
    "logDirectory": "/var/lib/qq-codex/logs",
    "allowedUsers": [{"userId":"Portal用户ID","qqId":"该用户QQ号","projects":["navigation"]}],
    "projects": {
      "navigation": {"directory":"/var/lib/qq-codex/projects/navigation","remote":"git@github.com:xiansakana/navigation.git","branch":"main"}
    }
  }
}
```

默认`enabled=false`、白名单为空、沙箱为`workspace-write`。当前服务器按所有者此前授权使用`danger-full-access`，仅绑定该所有者的QQ；允许的群也只接受该所有者发出的指令。Portal用户还必须启用并具备`qq-codex:execute`权限，位置为「首页→通知管理→QQ Codex→执行任务」；管理员通配权限可用，普通用户不会自动获得。每次接收、领取、执行心跳和结果投递都会检查授权。

复用`bookkeeping.wsUrl`（默认回环3001）和`napcat.accessToken`接收事件；Codex独立启用时无需启用记账。只新增一个消息分发处理器，不另开公网入口。qq-bot运行账号需要已登录Codex、可用Git远端凭据，以及共享SQLite访问权限。

任务、私聊及群聊会话ID、群设置、事件去重和待发送结果保存在共享数据库的`qq_codex_*`表中，按Portal `user_id`归属，群聊另外按`group_id`隔离。每个项目目录是服务端预置的授权配置，消息不能指定任意远端或目录。若为其他所有者开放，应配置独立项目检出和操作系统账号。

## Git行为

- 首次任务在独立目录克隆配置的分支；原有生产检出`/opt/navigation`不作为编辑目录。
- 开始前验证仓库根目录、远端、分支及已跟踪的根`AGENTS.md`，执行`fetch`与`merge --ff-only`。根/子目录规则随Git更新，CLI正常读取，不使用忽略规则参数。
- QQ任务产生的代码由Codex按项目规则测试、提交和推送；外层再次核验工作区干净、远端分支是本地HEAD祖先，再普通`push`，不会强推或自动覆盖并发提交。
- 全新会话遇到未提交修改或Git分歧会停止同步。原QQ会话可继续处理这些保留的修改，期间不强行合并；用户可要求它检查并解决分歧。未提交的电脑修改不会通过Git自动传输。
- 本地已提交并推送的修改，在下一次QQ任务拉取。QQ已推送的修改，本地`git pull --ff-only`取回；遇到分歧保留两端修改并人工决定合并。
- 任务默认不部署、不重启生产服务；只有QQ任务明确要求才按仓库`AGENTS.md`执行部署。

取消或超时会终止执行进程组，保留已有修改。服务重启中断的任务标记失败，不自动重放可能已发生的代码/运维操作；排队任务和待发送回执保留。失败后先查看`codex 状态/结果`，再决定是否继续。诊断仅落在私有日志目录，QQ不转发原始stderr或配置秘密。

## 部署与验证

按仓库流程推送、ECS干净拉取后，运行`bash scripts/ecs-update.sh --expected-sha <SHA> --only portal,qq-bot`。Portal包含新增权限定义。配置完成后重启qq-bot；不需要再部署一个工作器。

本服务器初次启用可运行`node scripts/configure-qq-codex.mjs`：仅当默认私聊目标已绑定启用的Portal管理员时创建授权，先克隆并检查代码/AGENTS，再备份旧配置、写入私有配置；不自动猜测或绑定其他QQ，也不会发送消息。已经启用时拒绝覆盖现有配置。之后执行`pm2 restart qq-bot`。

`/health`的`codex.enabled/running`表示入口配置与执行状态，`bookkeeping.connected`表示共用WebSocket是否连接。模型可用性需通过实际任务验证，不把启用开关当成模型连通证明。

使用与本机`portal/node_modules/better-sqlite3`匹配的Node版本运行`cd qq-bot && npm test`，以及Portal全套测试。覆盖真实WebSocket消息分发、白名单和权限、重复事件、取消、重启恢复、Git拉取/推送、AGENTS同步、并发分歧及未完成模型输出保护。
