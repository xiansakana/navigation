# 视频知识库

入口：`/knowledge/`，随 Portal 部署，无新增公网端口。上传 MP4、MOV、WebM，最大1GB、4小时。支持完整 Markdown 笔记、可编辑标题/分类/标签、按标题/标签/正文/转写搜索、时间戳回看、抽样画面、Markdown 导出和失败重试。

## 处理结构

1. Portal 验证权限并接收4MB分片；浏览器最多3路并发上传，显示实际发送进度、近5秒速度、预计剩余时间及本次上传/合并耗时。网络错误最多尝试3次，权限和格式错误不反复重试；失败会停止其他上传请求，已确认分片保留，可重新选择原文件继续上传。服务端并行接收分片，写入确认、合并及删除仍按文档串行执行。客户端以首尾各1MB及长度生成指纹，防止误选文件；这不是完整视频的内容哈希。
2. 完整视频在服务端合并后，任务持久化为 `queued`。个人工作器通过专用凭据领取任务。
3. 工作器使用 FFmpeg 抽取音频、采样画面，使用 faster-whisper 转写。十分钟窗口控制内存，窗口重叠2秒并去除已覆盖片段。
4. 总结模型先核对采样画面，再分段整理转写，最后合并完整笔记。超长视频采用分层合并，不直接截掉末尾转写。排盘画面额外返回结构化证据：同屏年/月/日/时四柱、元男/元女/乾造/坤造原文及真实截图文件；忽略无效干支、未知帧和非命主性别。时间从截图索引读取。证据以“画面核对依据”附在最终笔记中，避免文字合并遗漏性别；结构化识别失败会记录复核提醒。命理归集识别这些标记并保留依据，限定在对应案例范围，不根据儿子/女儿或配偶推断；重复来源有冲突时性别保持未知并提示核对。
5. 笔记、完整转写、画面索引和生成来源回传共享 SQLite；视频和截图保留在 Portal 私有目录，所有读取均校验账号和权限。

工作器可以运行在服务器，也可以运行在个人电脑；网页不依赖浏览器保持开启。CPU服务器建议单工作器、`base`/`small`、`int8`、1—2线程；本机有适配 CUDA 的 GPU 时可以使用 `cuda`。部署 Portal 不会自动安装大型语音模型或启动耗内存任务。

### 分阶段并发

「处理设置 → 并发设置」按账号保存、对每个工作器独立生效：默认转写/素材提取1路（可设1—2）、总结2路（可设1—4）。保存需要 `knowledge:settings:edit` 和 `knowledge:concurrency:edit`；工作器通过心跳获取设置，无需修改本机配置。降低并发只停止新增占位，不中断已运行的任务。

素材完成后，工作器以原租约持久化 `summary_wait`，释放转写位置，再申请总结位置；视频A总结时即可转写视频B，两个总结可同时执行。素材留在原工作器，没有阶段间额外的视频上传/下载。每台设备最多持有「转写上限 + 总结上限」个任务，避免提前领取大量任务。页面显示「正在转写/提取素材」「等待总结」「正在总结」，原有 `processing` 状态保持兼容；并发不改变模型配置和单任务内容。

不同设备可以同时处理同账号的不同视频。多台GPU工作器按各自空闲位置接单；只要有健康GPU在线且支持相应后端，CPU工作器就让出任务，防止小内存ECS同时加载语音模型影响网站。GPU离线后CPU仍可接续新任务。每个任务仍有唯一租约，不转移正在运行的任务。旧版设备保持每台一次一个任务；Windows工作器空闲自动更新后启用分阶段并发，ECS在空闲时通过 `scripts/reload-knowledge-worker-when-idle.py --wait-and-restart` 单独重载。一次任务失败只释放自己的位置。

## 上传与批量链接队列

上传入口默认B站链接，可切换「批量B站链接」或「上传本地视频（可多选）」。单条链接及批量链接均先保存到服务器SQLite `knowledge_upload_queue`：每批最多100条，最多500条等待/失败任务。五个活跃任务是下载与处理容量，不再是提交数量限制；有位置后按顺序读取信息、自动填写标题/分类/标签/来源、下载并进入原有GPU/总结流程。模型、强度、清晰度在提交时保存，之后修改默认设置不会改变等待任务。批量分类与标签作为共同补充，留空时使用各视频自动识别值。

链接队列刷新、关闭浏览器或服务重启后仍可接续。相同规范链接跳过；不同短链接解析为相同视频/分P后再次去重。单条无效输入会单独提示，其他有效链接继续入队；队列解析失败可重试，等待或解析中的任务可取消，已进入下载/处理的任务通过关联笔记管理。页面显示队列状态和关联笔记，并支持分页。取消解析会撤销其租约，迟到的解析结果不能再创建文档。

本地文件支持多选/拖拽最多100个，浏览器按空闲容量逐个上传，网络失败保留文件和已创建文档的续传信息；本地多个视频分别以文件名为标题。尚未传完的文件只保存在浏览器内存，必须保持页面打开，离开页面会提示；已上传的任务独立留在服务器继续处理。最多5个活跃任务及2000篇笔记的资源限额仍保留；已配置115的账号不限制累计视频容量，仅服务器存储账号保留20GB累计视频限额，文件不会一次全部发送或全部占用服务器磁盘。

队列权限为 `knowledge:queue:view`、`knowledge:queue:edit`、`knowledge:queue:manage`，添加/重试同时需要导入、上传和生成笔记权限；取消等待不依赖导入权限。数据按Portal账号隔离，后台提升任务时再次检查权限。

## 总结后端

网页「处理设置」切换 `Codex CLI` 和兼容 `OpenAI API`，默认值按用户保存在 SQLite。创建任务时固定所选后端，切换不改变已排队任务；失败重试使用当前选择。未配置的后端不会被工作器领取，页面显示其配置状态。

### Codex CLI

安装新版 CLI 并在**运行工作器的操作系统账号**下登录，检查：

```bash
codex --version
codex login status
```

无图形界面的服务器可使用 `codex login --device-auth`；如果环境不支持，官方也提供通过 SSH 迁移登录缓存的备用方案。凭据只能存于私有目录，不得提交 Git、贴入聊天、保存在公开工作器配置或导出笔记中。

CLI安装、登录成功，不等于网络连通；建议先执行短提示验证。需要代理时，仅在工作器的私有配置中填写 `codex.proxyUrl`，不会更改系统代理。Windows 上优先使用实际 `codex.exe` 路径，不能把 `.cmd` 脚本当原生可执行文件使用。

调用使用非交互 `exec`、`read-only`、`approval=never`、临时会话、忽略用户配置/规则和关闭 shell、MCP应用、浏览器等工具；只向模型提供转写与显式附带的画面。源码和用户凭据不是总结材料。空 `codex.model` 使用 CLI 默认模型；若需固定版本，填写模型名。需要支持 `--ignore-user-config`、`--ignore-rules` 的新版 CLI（本次验证版本0.163.0）。

官方参考：[服务器登录](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)、[非交互执行](https://learn.chatgpt.com/docs/non-interactive-mode)。

### 兼容 API

在工作器私有配置的 `openai` 中设置：

- `baseUrl`：以 `/v1` 等实际接口前缀结尾的地址，程序追加 `/chat/completions`。远程地址必须是 HTTPS，本机回环地址允许 HTTP。
- `model`：服务商实际支持的模型名，示例不预设模型。
- `apiKeyEnv`：密钥环境变量名，默认 `KNOWLEDGE_API_KEY`。也可在私有配置中使用 `apiKey`，但不建议把密钥写在启动命令中。
- `vision`：只有模型确实支持图片输入时设为 `true`；关闭时只总结转写，并明确标记截图未由模型核对。
- `maxTokensParameter`：默认 `max_completion_tokens`；只支持旧参数的服务可改为 `max_tokens`。单次上限12000，遇到输出截断明确失败，不把残缺笔记标成成功。

API 模式是独立的服务商接口，不会读取或转换 ChatGPT/Codex 的登录缓存。接口参数已通过本地 HTTP 协议测试；实际服务需配置有效模型、密钥并验证。

官方参考：[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[视觉输入](https://developers.openai.com/api/docs/guides/images-vision)。

## 启动工作器

需要 Node.js >=20.19、Python >=3.10、FFmpeg。不要使用只有Python3.6的系统解释器安装这组依赖。

```bash
# 在仓库根目录；把虚拟环境放在已忽略的 portal/data 下
python3 -m venv portal/data/knowledge-venv
portal/data/knowledge-venv/bin/python -m pip install -r portal/workers/requirements.txt
cp portal/knowledge-worker.config.example.json portal/knowledge-worker.config.json
```

Windows 对应的 Python 路径为 `portal/data/knowledge-venv/Scripts/python.exe`。CUDA 设备还需要兼容的 NVIDIA 驱动、cuBLAS和cuDNN；工作器会载入虚拟环境中 `nvidia/*/bin` 的DLL目录，CPU模式无需这些包。依赖安装在用户指定的工作器机器上，不增加 Portal 的 Node 生产依赖。

在网页「处理设置」生成个人工作器凭据，填入私有配置：

```json
{
  "portalUrl": "https://你的导航域名",
  "token": "网页生成的个人凭据",
  "label": "服务器视频工作器",
  "python": "/opt/navigation/portal/data/knowledge-venv/bin/python",
  "ffmpeg": "ffmpeg",
  "asr": { "model": "base", "device": "cpu", "threads": 1 },
  "codex": { "binary": "codex", "model": "", "proxyUrl": "" },
  "openai": { "baseUrl": "https://api.openai.com/v1", "model": "", "vision": true }
}
```

`portalUrl` 必须是站点根地址；服务端工作器也可用 `http://127.0.0.1:80`。`token` 可改用 `KNOWLEDGE_WORKER_TOKEN` 环境变量，优先于配置。工作器配置和环境变量不会回传浏览器。启动：

```bash
node scripts/knowledge-worker.mjs portal/knowledge-worker.config.json
# 或在该机器持久运行，避免重复启动多个耗资源实例
pm2 start scripts/knowledge-worker.mjs --name knowledge-worker -- portal/knowledge-worker.config.json
```

首次运行语音模型可能需要下载。`asr.model` 可以填已下载的 CTranslate2 模型目录；`asr.modelCache` 可固定缓存目录。未安装转写依赖、CLI未登录或API未配置时，工作器只报告状态，不领取不具备条件的任务。状态中的“可用”是安装/登录或配置检查，模型网络在实际任务中验证。

### Windows 安装与独立设备

知识库“处理设置”提供“安装并连接这台电脑”，需要 `knowledge:devices:install`、`knowledge:devices:edit` 和 `knowledge:process:edit` 权限。下载 `Navigation-Knowledge-Worker-Setup.exe` 后双击运行，安装界面显示进度及日志，自动解包并执行安装流程；浏览器不能静默执行本机程序。EXE 引导程序兼容 Windows 10/11 内置的 .NET Framework，绑定数据以独立尾部载荷附加，公共引导程序不包含账号凭据。源代码在 `scripts/windows-worker/Installer.cs`，通过 `scripts/build-knowledge-worker-exe.ps1` 构建；服务端同时核对源码及二进制哈希。用于自动更新的 ZIP 接口保持不变。安装包仅附带10分钟有效、只能使用一次的账号绑定授权，不包含长期凭据、服务器登录或源视频。请勿转发仍有效的个人安装包。过期时安装程序显示配对码并打开知识库，登录后核对设备名称及配对码再确认。

若Chrome拦截EXE，可在同处点击“下载脚本安装包（ZIP）”。这是真实的脚本源码安装包，不是改名封装的EXE；需额外`knowledge:devices:install-zip`权限，服务端同时验证原安装、设备绑定和处理权限。全部解压后双击`scripts/knowledge-worker-setup.cmd`，执行同一套安装流程；10分钟内自动绑定，过期需网页确认。不要直接从压缩包内运行，也不要转发尚未使用的配对授权。无需关闭Safe Browsing、Defender或修改浏览器策略；ZIP不保证在所有组织安全策略下都可下载。EXE尚无受信发布者签名，不能承诺消除浏览器拦截，具体拦截原因需依据Chrome安全检测结果判断。

安装器通过`node --version`读取并校验主版本，兼容Windows PowerShell 5.1和PowerShell 7；不通过`node -p/-e`传含引号的JavaScript。已安装Node>=22直接复用；否则优先复用安装目录的便携Node，再按原SHA256校验流程下载。`-CheckOnly`只检查平台和实际Node主版本，不创建配置、不绑定设备、不下载依赖或启用启动任务。

所有打包的`.ps1`采用带BOM的UTF-8，避免Windows PowerShell 5.1按系统代码页误读中文及字符串边界；注册任务脚本的引导文字保持ASCII。回归测试在隔离PowerShell进程中复现旧版`PositionalParameterNotFound`，并验证修复后任务名称、含空格/中文路径、当前用户低权限登录触发与启动调用，不实际修改测试机器任务。如果依赖已安装且仅在注册自启动阶段失败，可修复安装目录的注册脚本后，仅执行`install-knowledge-worker.ps1 -ConfigPath <安装目录/config.json> -NodePath <node.exe>`，无需重新配对或安装Python/CUDA依赖。

安装器面向 Windows x64：优先使用已有 Node 22+，否则下载带官方 SHA256 校验的 Node 22.20.0；安装独立 Python 3.11.9 时核验 Python Software Foundation 数字签名，创建私有环境并安装固定的语音依赖、FFmpeg 和可选 CUDA 推理库。首次需要联网下载依赖和语音模型。已有 Codex 原生程序会复用其登录；否则按 [OpenAI Docs](https://learn.chatgpt.com/docs/codex/cli) 安装 CLI 并引导用户登录。网站账号与 Codex 账号授权独立，不在设备间复制 Codex 登录缓存。

运行文件位于 `%LOCALAPPDATA%/Navigation/KnowledgeWorker/releases/`，私有配置为同目录下的 `config.json`，缓存、模型独立保存。设备凭据在服务端仅保存哈希，网页设备列表不返回凭据。设备有独立ID、名称、心跳和停用状态；停用只取消该设备的访问和正在持有的任务租约，不影响其他设备。旧版共享凭据收进高级设置，轮换不再撤销独立设备。

安装后的工作器每15分钟空闲时检查更新；通过已有设备凭据下载固定文件清单的 ZIP，验证 SHA256 后放入新版本目录并切换，网络失败继续使用旧版本。更新不会覆盖账号配置、模型和缓存，不打断正在处理的视频。此更新仅覆盖工作器代码，Python/CUDA依赖调整需重新运行安装程序修复。重新运行会复用仍有效的独立设备凭据；已停用时需重新绑定。现有手工工作器保持兼容，可用 `setup-knowledge-worker.ps1 -ReuseConfig <原私有配置>` 迁移环境。

### ECS 后台运行与 CordCloud 代理

无桌面服务器可使用 CordCloud 官方提供的 Clash 通用订阅配合 Mihomo 核心，按[官方 systemd 文档](https://wiki.metacubex.one/startup/service/)运行。当前部署使用已核验发布包 SHA256 的 Mihomo v1.19.32；没有安装图形客户端。订阅、节点口令和 Codex 登录缓存均为运行时私有文件，不进入 Git。

- `cordcloud-proxy.service` 开机启动；HTTP/SOCKS 混合端口为 `127.0.0.1:17890`，管理端口为 `127.0.0.1:19090`，管理接口另有随机密钥。未开放公网端口、TUN或全局系统路由。
- 代理配置位于 `/etc/cordcloud-proxy/config.yaml`，仅 root 与服务组可读；包含本次从官方订阅取得的节点快照。供应商变更节点后，需要重新取得订阅并更新此文件，随后重启代理。
- root 可使用 `codex-via-proxy` 启动已登录的 CLI；它读取 `/root/.config/cordcloud-proxy.env`，只影响本次进程。工作器使用私有配置中的 `codex.proxyUrl`。
- ECS 工作器私有配置位于 `/etc/knowledge-worker/config.json`，任务缓存和预下载模型位于 `/var/lib/knowledge-worker/`。配置中的令牌须来自对应用户的知识库页面；更换网页令牌后同步更新此文件。
- Python 3.11 与独立虚拟环境用于 CPU 转写，线程数为1。`scripts/knowledge-worker.service.example` 给出了开机服务及CPU/内存限制；配置、模型和目录准备好后，再将其安装为 `/etc/systemd/system/knowledge-worker.service` 并启用。服务在 Portal 以外运行，单独重启不会重启网站。
- 同一账号的工作器共享队列，各设备按上述阶段并发限制独立领取。每台工作器分别记录身份和心跳；最近90秒内有健康且支持相应后端的CUDA工作器时CPU让出任务，即使GPU暂忙；多台GPU可独立接单，GPU离线后CPU可接新任务。已经开始的任务继续使用原租约，不迁移或重复执行；处理中断仍按15分钟租约超时提示失败并允许重试。
- Windows 本机使用 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-knowledge-worker.ps1` 注册当前用户登录启动任务，并立即隐藏启动。无需密码，使用当前用户的私有工作器配置与CLI登录；退出后15秒重试，同一用户会话用互斥锁防重复。每日运行日志位于 `%LOCALAPPDATA%/Navigation/knowledge-worker/`。通过任务计划程序停止/禁用 `Navigation Knowledge GPU Worker` 可关闭自动启动。CUDA配置用 `asr.device: "cuda"`；健康检查会验证CUDA设备与Windows推理库，可用时才优先调度。

运维检查：`systemctl status cordcloud-proxy knowledge-worker`；工作器日志为 `journalctl -u knowledge-worker`。代理是否在线与 CLI 是否登录需要分别验证；本次已通过服务器代理执行真实 CLI 短提示。

## 权限、隐私与恢复

- 所有 `knowledge:*` 权限目录位于「首页 → 知识库」。普通登录用户默认拥有自己的知识库权限；游客禁止访问。
- 笔记、原视频、转写、截图、编辑、删除、导出、上传、生成、后端设置和工作器凭据分别校验。管理员也不能通过这些接口跨账号读取记录。
- 工作器token仅以SHA256存于数据库，绑定单一 Portal 用户；账号停用或相关权限撤销后不再接受工作器请求。更换token立即撤销旧连接并使在途任务失败。
- 领取任务使用数据库事务和随机租约，进度每20秒心跳，超过15分钟无响应撤销旧租约并回到GPU等待队列，GPU恢复后自动领取并复用可用缓存。过期工作器不能覆盖重试后的结果或已删除任务。
- 任务失败保留原视频和已经完成的笔记，不自动反复调用模型；用户选择重试。工作器本地保留已提取素材供同一任务复用，成功入库后删除该任务本地缓存。更换后端重试会重新总结。
- 同一账号最多5个上传/排队/处理任务、2000篇记录，单个视频最大1GB。已配置115的账号不设累计视频容量限额，本地上传、单条及批量B站导入均适用；未配置115的服务器存储账号保留20GB累计视频限额。上传时仍检查ECS临时磁盘空间，115实际可用容量以网盘账号为准；删除同时清理对应私有文件。
- 原视频及截图不会上传公开B2图床。模型接收的材料取决于所选CLI/API后端与视觉设置。
- 抽样画面不等于逐帧观看；转写可能有同音字错误，视觉核对也不能保证消除错误。笔记保留生成模型、时间、语音模型与识别范围，不把模型判断冒充独立验证事实。

## 存储与部署

共享SQLite：`knowledge_documents`、`knowledge_parts`、`knowledge_settings`、`knowledge_workers`、`knowledge_sources`，均按 Portal 用户隔离。表在首次访问创建，不需要单独手工SQL迁移。

服务端文件：`portal/data/knowledge/<32位文档ID>/`。工作器临时缓存默认 `portal/data/knowledge-worker/`。SQLite备份包含文本和索引，完整备份还必须包含截图目录和实际原视频存储（启用115后为网盘目录）；工作器临时目录无需作为知识库备份。

本次部署只需 `portal`，并单独安装/重启两个工作器服务。Nginx更新由现有 `scripts/sync-blog-upload-nginx.py` 管理，增加 `/api/knowledge/` 的20MB请求上限和流式代理，覆盖4MB分片及18MB以内的结果包。常规部署仍遵守推送、ECS拉取及`--expected-sha`校验流程。

### 115原视频存储

通过仅监听回环地址的 OpenList v4.2.7「115 Open」驱动接入用户授权的115账号，独立于已有AList挂载。授权和刷新由OpenList维护；不要把刷新令牌或管理令牌放入代码、日志或浏览器。参考[驱动文档](https://doc.oplist.org/guide/drivers/115_open)及[官方上传实现](https://github.com/OpenListTeam/OpenList/blob/v4.2.7/drivers/115_open/driver.go)。

创建私有 `portal/data/knowledge-storage.json`（权限600），也可用 `KNOWLEDGE_STORAGE_CONFIG` 指定：

```json
{"users":{"Portal用户ID":{"baseUrl":"http://127.0.0.1:15244","token":"OpenList私有管理令牌","rootPath":"/115/Navigation-Knowledge"}}}
```

这是服务端凭据配置；任务状态、归档索引和归属均保存在共享SQLite。只为绑定的Portal账号启用115，其他账号保持原有存储，避免把他人视频上传到同一个私人网盘。原片路径为配置根目录/账号哈希/文档ID/source.mp4（或webm/mov）。不要直接重命名网盘目录或删除原片，操作应通过知识库完成。

准备私有配置与回环OpenList服务后，安装 `scripts/knowledge-storage-worker.service.example` 为systemd服务并启用。先部署代码，再运行 `node scripts/knowledge-storage-worker.mjs --migrate`，将已配置账号的已有原片加入归档队列；不会重新生成笔记。OpenList服务也需开机启用。检查 `systemctl status navigation-115-open knowledge-storage-worker knowledge-worker`。

上传流程：4MB分片可续传 → ECS合并临时原片 → 后台上传115 → 从115完整下载并比对字节数和SHA256 → 记录校验检查点 → 删除ECS原片 → 总结工作器领取任务。ECS仍承接上传、校验和转写期间的临时空间，上传检查至少保留5GB系统余量。115云端上传失败后会重新发送完整文件；工作器下载支持Range续传及完整哈希验证。已经提取素材的重试复用素材，提取成功后清理工作器原片缓存。115保存与完整性校验分别记录本次操作的起始时间和耗时，页面在状态刷新时显示；历史已归档视频没有追溯耗时。

归档任务独立于总结任务，15秒心跳，失联2分钟可重新领取；失败最多自动尝试5次并退避，页面提供独立权限的手动重试。远端已有同一路径时先复核，避免重启产生重复文件。校验不一致或网盘不可用时保留本地临时原片，停止进入总结队列。已校验检查点支持重启恢复清理。

回看通过原有受鉴权接口流式代理115，支持Range拖动；浏览器得不到管理令牌、对象路径或签名下载URL。删除先持久化待删除状态并从列表隐藏，再由存储工作器清理115对应文档目录、本地截图和数据库记录；失败保留清理状态重试。正在归档的原片需等当前任务结束后删除。达到自动重试上限的删除任务可通过运维检查 `knowledge_sources` 的 `deleting` 状态处理，不会静默遗忘远端文件。

## 验证

```bash
cd portal
node --test src/*.test.js
```

Node 版本需与现有 `better-sqlite3` 本机二进制匹配。新增测试覆盖上传完整性、Range播放、租约重入/过期、重试、凭据撤销、跨用户/游客/API权限、乐观并发编辑、文字与转写搜索、Markdown导出、API图文调用与截断失败，以及CLI工具隔离参数。

## 拖拽上传与播放来源

上传面板支持拖拽一个 MP4 / WebM / MOV 文件，使用与文件选择相同的分片续传流程；会检查文件类型、空文件和大小。选择文件后自动填入标题，续传时保留原任务标题。

笔记的“原视频”页在有有效来源链接时默认嵌入来源页面，B站视频链接使用官方外链播放器并保留分P；未填写链接则默认播放归档。播放来源可切换“原视频链接 / 115归档视频”（本地存储账号显示服务器归档），只在打开原视频页时加载。第三方禁止嵌入或需要登录时可打开原网页，或切换归档。点击转写时间会切到归档并跳转对应时间。来源链接不会用于下载、替代上传或改变115归档流程；继续使用 knowledge:source:view 权限。

## 转写执行设备排查

严格仅GPU处理：只有90秒内有心跳、media就绪且设备为CUDA、支持任务所选总结后端的GPU工作器可以领取。CPU、未知设备、GPU离线或未就绪时，任务留在队列暂停等待，绝不回退CPU；GPU恢复自动接续。工作器探测和实际转写均强制CUDA，设备丢失不允许auto降级CPU。页面的就绪状态只统计可用GPU，设备列表仍可显示CPU心跳。Codex桌面更新可能移除旧的哈希目录，工作器现在只对Windows桌面安装目录中的失效CLI路径自动寻找新版本，保留自定义显式路径的失败行为；能力检测和每次总结调用使用相同解析。不会复制登录凭据或改变模型。

转写进度显示实际CPU/GPU CUDA、已处理音频时间/总时长和本次转写用时；工作器日志记录模型加载、ASR和素材提取耗时，避免将115归档、下载或模型总结的等待算成语音转写。已在运行中的任务不会迁移或因升级重启。

## 本机GPU原视频直送与并行归档

Windows工作器默认监听 `127.0.0.1:17891`，只允许私有配置portalUrl对应的Origin/Host。网页上传时同时将所选Blob发送至本机，并继续原有ECS分片上传；无需选择本机路径或将路径发给服务器。首次连接可能需要浏览器允许本地网络访问。`localUpload:false` 可禁用接收端口。

直送使用 `knowledge:local-input:edit`，同时要求上传和处理权限。网页先探测本机工作器ID，再向Portal申请10分钟、单文档/单账号/单设备的一次性接收票据；不把工作器长期令牌交给网页。工作器先验证票据，流式落入私有缓存并计算完整SHA256，向Portal确认后票据即失效。ECS合并分片时同步计算完整SHA256。只有两份校验值相同、缓存仍存在的指定工作器可在115未ready时领取；仍保持每账号单任务租约。不会仅凭文件名或头尾指纹信任本地缓存。

网页在服务器分片传输期间完成本机直送，然后提交合并；上传完成后本机校验并直接处理原片，不执行115回下载。115上传/校验/清理仍由独立归档服务继续，笔记可先完成，归档失败独立重试且不回滚笔记。浏览器本地网络权限被拒绝、工作器离线、端口占用或本机存储不足时，自动恢复原归档后处理流程；GPU离线后继续归档，但视频处理保持等待GPU，ECS的CPU不会领取。远端GPU不等于当前电脑：探测与票据绑定可避免将文件误送给其他设备。

本机复制文件在任务成功后清除；失败保留用于重试。工作器空闲且没有正在接收文件时，每小时清理超过24小时的本机直送缓存，保留至少2GB本机空闲空间。服务器删除笔记会清理直送索引，未在线的本机由过期缓存清理兜底。现有手动部署工作器需空闲重启一次；新版安装工作器自动获取包含直送模块的更新。

## 自定义总结模型与推理强度

知识库“处理设置”可选择或输入模型名称，设置low/medium/high/xhigh/max/ultra（需所选模型支持），点击“保存模型设置”。CLI/API分别保存自己的模型与强度；留空继承工作器私有默认配置。模型设置需要 knowledge:settings:edit 和独立 knowledge:model:edit 权限，不允许网页修改连接地址、凭据、代理或CLI程序路径。

配置保存在共享SQLite的knowledge_settings.model_settings_json，按user_id隔离。创建文档时将配置快照写入knowledge_documents.model_settings_json；排队和处理中保持快照，修改默认值不影响旧任务。失败重试重新快照当前默认。没有快照的历史任务继续原工作器默认行为；成功笔记provenance保存请求的模型和reasoningEffort，不反推历史强度。

工作器将任务选择覆盖到本次调用副本：CLI使用 -m 与 -c model_reasoning_effort，兼容Chat Completions API使用model及可选reasoning_effort。所有画面核对、分段笔记、合并均使用本任务配置，保留原工具隔离与完整证据策略。模型或强度不可用时任务明确失败，不自动升级到更贵模型；API需支持对应字段。ASR仍使用本机/服务器Whisper，不受总结模型选择影响。

批量日常整理可从GPT-6 Luna + high开始；重要排盘、命例映射或视觉细节建议用GPT-6.1 Sol + low复核，复杂内容再升medium。一次工作主题视频的固定材料对比中Luna/high优于Luna/medium的案例关联，但单样本不足以保证所有视频的质量或固定节省比例。不要以缩减画面证据来换取表面节省。

## B站链接导入

知识库“上传视频”中选择“粘贴B站视频链接”，粘贴视频页或b23.tv分享链接后读取视频信息。标题、分类建议、平台标签和规范来源链接会自动填写，允许提交前修改。带`?p=2`的链接只导入第二个分P，不下载整套合集。普通本地文件上传保持不变。日常笔记可先用Luna/high，重要案例可用Sol/low复核。

Portal使用B站元数据/播放接口下载当前账号可访问的视频，以H.264流用FFmpeg无重编码合并音视频；没有额外Python、yt-dlp或浏览器扩展运行依赖。未绑定账号时按匿名访问处理；已绑定时使用当前用户的独立登录凭据。没有权限、试看及平台限制会明确失败，不使用第三方解析服务或共享Cookie。暂不支持其它视频网站或合集批量导入。

新增权限`knowledge:import:edit`（首页/知识库/上传视频/链接导入），预览、提交和下载重试同时要求上传、生成笔记权限。后台定期检查账号权限。所有任务归属当前用户，下载目标只接受规范B站视频URL，媒体域名限制为B站CDN，重定向再次校验，限制4小时/1GB；按1GB为每个下载任务保留逻辑配额，完成后替换为实际大小。

自动迁移新增`knowledge_imports`持久队列表；Portal每次串行下载一个视频，重启后可恢复过期下载租约；失败可点原有重试按钮重新下载。视频完整下载并计算SHA256后交给原有GPU专用队列，115归档并行，工作器优先从ECS临时原片读取；临时原片已清理时改读已校验的115归档。已在下载中的任务暂不允许删除，等待完成或失败后可删除。

部署仅需`portal`，沿用已安装的FFmpeg，可用服务环境变量`KNOWLEDGE_IMPORT_FFMPEG`指定完整路径。下载临时空间和115归档仍遵循原有磁盘检查与完整性校验。备份新增表及原有知识库表、材料目录；无需更换或重装本机GPU工作器。

### B站扫码绑定与清晰度

“处理设置 / B站账号与视频清晰度”支持扫码绑定、检查登录状态、解除绑定和保存默认画质。二维码约3分钟有效，用户需用B站手机端确认；服务重启需重新生成未完成的二维码。只将成功扫码响应的允许Cookie交给B站自身的登录检查/播放接口，不交给CDN、115、GPU工作器或总结模型。凭据失效明确提示重新绑定，不自动回退匿名下载。

默认1080p严格模式；可改为720p、480p、360p，或显式允许使用不高于目标的最高可用清晰度。预览展示实际返回的视频流，不能把`accept_quality`中未授权的画质当成可用。创建任务时保存选择，下载时重新校验；严格模式无目标画质时不下载。用户改变默认值不修改已排队快照；下载失败后重试采用当前默认设置。现有版本升级前的导入任务保留原自动降级策略。

下载合并后使用FFprobe验证画面、音轨及实际宽高，存入`knowledge_imports.media_json`和最终笔记provenance，笔记页面与Markdown导出显示实际分辨率和降级提示。可用`KNOWLEDGE_IMPORT_FFPROBE`指定FFprobe路径。登录不保证1080p或会员清晰度；仍受源视频、账号权限及平台限制影响。

新增`knowledge_bilibili_accounts`按`user_id`存储AES-256-GCM密文、公开状态和偏好；账号ID作为AAD防止跨账号交换密文。首次绑定时生成独立32字节密钥`portal/data/knowledge-bilibili.key`（Linux权限0600），可用`KNOWLEDGE_BILIBILI_KEY_FILE`指定位置。备份需同时保存该密钥与账号表，并分开保护；只有数据库备份无法恢复凭据。密钥和私有数据不得入Git、日志或聊天。解除绑定清除密文并保留画质偏好，不退出用户其它B站设备。

权限为`knowledge:bilibili:view`（查看/检查自己的状态）、`knowledge:bilibili:edit`（扫码/解绑）、`knowledge:quality:edit`（默认清晰度），均位于首页/知识库/处理设置对应层级；预览、单次画质选择与导入继续使用链接导入权限。仅新增Node依赖`qrcode@1.5.4`用于本地生成二维码，不请求第三方二维码服务。

数据库短暂写锁冲突返回 HTTP 503、`KNOWLEDGE_BUSY` 和 `Retry-After`；工作器只对这一明确可重试状态进行有界退避，不盲目重放网络失败的领单请求。完整结果写入本机缓存后，如入库失败，原笔记信息及模型设置一致时可复用结果重新提交，避免再次调用模型。

### Windows工作器系统代理

安装配对、自动更新和实际工作进程自动读取当前用户启用的Windows手动HTTP(S)代理（支持统一地址或http=/https=分项），优先保留显式HTTP_PROXY/HTTPS_PROXY环境配置。Node启动时启用环境代理，心跳、任务领取和视频下载均沿用该连接；localhost/127.0.0.1/IPv6回环始终直连，不影响网页本机视频直送。不记录代理凭据、不修改系统代理；PAC脚本和SOCKS配置不自动转换。新版安装器校验Node支持--use-env-proxy，不支持时安装校验过SHA256的22.23.2运行时。

### 私有笔记分页

“我的知识库”按每页30篇显示上一页、下一页和页码/总篇数，沿用knowledge:notes:view权限。自动状态刷新保留当前页和已应用筛选，不会重置为首30篇；搜索提交、分类或状态筛选变化回到第一页。删除导致当前末页为空时自动回到最近有效页。翻页保留跨页勾选，筛选变化清空勾选；全选仅针对本页已生成笔记，批量修改仍由服务端核对归属和版本。

### 视频来源链接去重

在同一账号内，按B站视频编号和分P识别重复，忽略HTTP/HTTPS、www/m域名、末尾斜线、分享参数及时间锚点，p=1与默认首页相同；不同分P可分别入库。其他HTTP(S)链接保留查询参数的业务含义。

统一校验本地上传的来源链接、单条导入、批量队列，以及修改来源链接；同时读取历史笔记source_url和knowledge_imports保留的原始导入链接，不依赖笔记是否由新版队列创建。已有笔记和在途任务均占用该视频来源，失败任务需重试原任务，删除完成后可重新导入。短链接/AV地址在解析为BV链接后再次校验，进入下载和模型处理前拦截。创建文档在即时事务内重新校验，避免并发重复创建；不会自动删除已有重复笔记。

重复提交返回KNOWLEDGE_DUPLICATE_SOURCE/409（批量则逐条返回duplicate并跳过），具备knowledge:notes:view权限时提供已有笔记入口，无该权限不返回其标题或ID；仅按当前账号查重，不泄露其他账号的库内容。单条读取信息发现重复后禁用导入按钮，更换链接或切换来源模式后可重新操作。

### 多命盘与对比案例

识别同屏或相邻画面的多张命盘时，先结合标题、人物称谓、位置和口述判断人物对比、合婚、亲属案例或同人版本修正；不默认多盘都是同一人的矛盾版本，也不凭多盘断言有多个真实人物。结构化画面证据保留每张命盘的subject、position、relation、四柱、性别标记和截图时间，同一截图可有多项。关系不明保留待核对，同人版本的矛盾证据仍保留。

明确对比时，正文与画面依据以稳定的“对比对象：称谓”关联记录。命理知识案例索引按四柱和明确对比对象区分，即使四柱相同也不合并不同对象的性别；唯一明确对象可与同四柱的正文证据合并，多个对象下无归属的证据保留待核对，不擅自分配。索引版本升级为knowledge-bazi-v4，读取时重新索引已有正文，不重新调用模型、不改写已有笔记。生成规则在工作器更新后的后续分析中生效。

### 旧笔记重新分析与历史版本

搜索工具栏顺序为分类、状态、搜索、一键重试全部失败、批量重新分析，按钮不换行，小屏在工具栏内横向滚动。单篇详情提供重新分析；批量优先采用跨页勾选，无勾选时采用当前搜索词和分类下全部已生成笔记。先预览具体ID及revision，再确认提交，服务端重新检查归属、状态、版本和素材，逐条返回排队与跳过原因；重复提交不会重复排队。不重新导入视频，不改变原笔记ID或来源URL，沿用提交时当前模型和强度。

默认reuse只下载已保存的转写和关键画面到工作器，不下载原视频、不重复ASR，仍要求本机GPU就绪。full模式从服务器缓存或115读取原视频并重新转写、抽帧。只由声明reanalysis.version=1的新版GPU工作器领取，旧版设备不领取这些任务；缺失素材时提示选择full模式。运行标识隔离旧evidence/result缓存，失败重试沿用同次缓存。未确认前仅做预览，不消耗总结调用。

每次开始前保存旧正文、转写、画面元数据和模型来源，最近10版按账号/笔记隔离；排队或失败期间保留旧正文。重新分析的新截图采用运行标识命名，不覆盖旧截图，历史预览提供正文，恢复时恢复对应正文和素材并同步命理案例，同时保存恢复前版本。处理中不可恢复或编辑，恢复不改变当前可见范围、标题和来源链接。删除笔记同步清理其版本记录及截图文件。

新增权限：knowledge:reanalysis:edit、knowledge:reanalysis:batch:edit、knowledge:history:view、knowledge:history:restore；分别挂在笔记的重新分析、批量重新分析、历史版本和恢复路径，默认个人账号获得，API同时要求生成/笔记查看权限，历史正文不返回受限的原始转写数据。
