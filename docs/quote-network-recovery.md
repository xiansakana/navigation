# 行情连接与超时保护（2026-10-08）

stock-manage 与 qqq-dip 在进程启动时调用 shared/quote-network.js：DNS优先IPv4，地址自动选择的单地址等待改为2000ms。保留多个地址和IPv6回退；不是全局关闭服务器IPv6。其他服务未调用此策略。

现场Node20默认单地址等待250ms，服务器无IPv6默认路由；到Cboe的IPv4握手实测282–1337ms。独立HEAD探测复现IPv4 ETIMEDOUT与IPv6 ENETUNREACH并存，延长等待后可完成连接。此结果说明连接策略能触发过早失败，不证明所有上游故障都来自该策略。Finnhub还出现完成TLS但8秒无响应的情况。

两个模块统一使用有硬截止的报价请求：每次连接/响应头及响应体共用12秒预算，最多3次尝试；HTTP401等非临时错误不重试。HTTP429保留各模块的退避。取消未能使Promise结束时，截止仍会释放调用方。最后失败日志记录时间、主机、阶段、尝试次数、底层聚合错误及IP；移除错误URL中的账号、查询参数和fragment，避免泄露API密钥。

qqq-dip已有阶段及整轮超时保护继续保留。连接策略不能替代该保护，也不能解决供应商限流、真实响应迟滞或行情授权问题。没有增频、购买订阅或切换行情源。

部署：按DEPLOY-ECS.md和AGENTS.md的精确SHA流程，仅更新stock-manage、qqq-dip。没有数据库结构迁移。检查两服务启动日志中的“行情网络策略”，以及梭哈请求审计和抄底monitor的lastCompletedAt/checks持续推进。一次成功不等于彻底消除网络波动。

参考：[Node20 net API](https://nodejs.org/download/release/latest-v20.x/docs/api/net.html)。
