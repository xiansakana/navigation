# 视频知识库

入口：`/knowledge/`，随 Portal 部署，无新增公网端口。上传 MP4、MOV、WebM，最大1GB、4小时。支持完整 Markdown 笔记、可编辑标题/分类/标签、按标题/标签/正文/转写搜索、时间戳回看、抽样画面、Markdown 导出和失败重试。

## 处理结构

1. Portal 验证权限并接收4MB分片；浏览器保留在服务端的分片进度，可重新选择原文件继续上传。客户端以首尾各1MB及长度生成指纹，防止误选文件；这不是完整视频的内容哈希。
2. 完整视频在服务端合并后，任务持久化为 `queued`。个人工作器通过专用凭据领取任务。
3. 工作器使用 FFmpeg 抽取音频、采样画面，使用 faster-whisper 转写。十分钟窗口控制内存，窗口重叠2秒并去除已覆盖片段。
4. 总结模型先核对采样画面，再分段整理转写，最后合并完整笔记。超长视频采用分层合并，不直接截掉末尾转写。
5. 笔记、完整转写、画面索引和生成来源回传共享 SQLite；视频和截图保留在 Portal 私有目录，所有读取均校验账号和权限。

工作器可以运行在服务器，也可以运行在个人电脑；网页不依赖浏览器保持开启。CPU服务器建议单工作器、`base`/`small`、`int8`、1—2线程；本机有适配 CUDA 的 GPU 时可以使用 `cuda`。部署 Portal 不会自动安装大型语音模型或启动耗内存任务。

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

### ECS 后台运行与 CordCloud 代理

无桌面服务器可使用 CordCloud 官方提供的 Clash 通用订阅配合 Mihomo 核心，按[官方 systemd 文档](https://wiki.metacubex.one/startup/service/)运行。当前部署使用已核验发布包 SHA256 的 Mihomo v1.19.32；没有安装图形客户端。订阅、节点口令和 Codex 登录缓存均为运行时私有文件，不进入 Git。

- `cordcloud-proxy.service` 开机启动；HTTP/SOCKS 混合端口为 `127.0.0.1:17890`，管理端口为 `127.0.0.1:19090`，管理接口另有随机密钥。未开放公网端口、TUN或全局系统路由。
- 代理配置位于 `/etc/cordcloud-proxy/config.yaml`，仅 root 与服务组可读；包含本次从官方订阅取得的节点快照。供应商变更节点后，需要重新取得订阅并更新此文件，随后重启代理。
- root 可使用 `codex-via-proxy` 启动已登录的 CLI；它读取 `/root/.config/cordcloud-proxy.env`，只影响本次进程。工作器使用私有配置中的 `codex.proxyUrl`。
- ECS 工作器私有配置位于 `/etc/knowledge-worker/config.json`，任务缓存和预下载模型位于 `/var/lib/knowledge-worker/`。配置中的令牌须来自对应用户的知识库页面；更换网页令牌后同步更新此文件。
- Python 3.11 与独立虚拟环境用于 CPU 转写，线程数为1。`scripts/knowledge-worker.service.example` 给出了开机服务及CPU/内存限制；配置、模型和目录准备好后，再将其安装为 `/etc/systemd/system/knowledge-worker.service` 并启用。服务在 Portal 以外运行，单独重启不会重启网站。
- 同一账号的工作器共享队列，同一时间只领取一个任务。本机 GPU 与服务器同时在线时，下一个任务由先领取者处理；并不自动优先 GPU。

运维检查：`systemctl status cordcloud-proxy knowledge-worker`；工作器日志为 `journalctl -u knowledge-worker`。代理是否在线与 CLI 是否登录需要分别验证；本次已通过服务器代理执行真实 CLI 短提示。

## 权限、隐私与恢复

- 所有 `knowledge:*` 权限目录位于「首页 → 知识库」。普通登录用户默认拥有自己的知识库权限；游客禁止访问。
- 笔记、原视频、转写、截图、编辑、删除、导出、上传、生成、后端设置和工作器凭据分别校验。管理员也不能通过这些接口跨账号读取记录。
- 工作器token仅以SHA256存于数据库，绑定单一 Portal 用户；账号停用或相关权限撤销后不再接受工作器请求。更换token立即撤销旧连接并使在途任务失败。
- 领取任务使用数据库事务和随机租约，进度每20秒心跳，超过15分钟无响应标为失败。过期工作器不能覆盖重试后的结果或已删除任务。
- 任务失败保留原视频和已经完成的笔记，不自动反复调用模型；用户选择重试。工作器本地保留已提取素材供同一任务复用，成功入库后删除该任务本地缓存。更换后端重试会重新总结。
- 同一账号最多5个上传/排队/处理任务、20GB原视频或2000篇记录。上传时检查磁盘空间，删除同时清理对应私有文件。
- 原视频及截图不会上传公开B2图床。模型接收的材料取决于所选CLI/API后端与视觉设置。
- 抽样画面不等于逐帧观看；转写可能有同音字错误，视觉核对也不能保证消除错误。笔记保留生成模型、时间、语音模型与识别范围，不把模型判断冒充独立验证事实。

## 存储与部署

共享SQLite：`knowledge_documents`、`knowledge_parts`、`knowledge_settings`、`knowledge_workers`，均按 Portal 用户隔离。表在首次访问创建，不需要单独手工SQL迁移。

服务端文件：`portal/data/knowledge/<32位文档ID>/`。工作器临时缓存默认 `portal/data/knowledge-worker/`。SQLite备份只包含文本和索引，**完整备份还必须包含服务端视频/截图目录**；工作器临时目录无需作为知识库备份。

本次部署只需 `portal`。Nginx更新由现有 `scripts/sync-blog-upload-nginx.py` 管理，增加 `/api/knowledge/` 的20MB请求上限和流式代理，覆盖4MB分片及18MB以内的结果包；合并视频保留在服务器。常规部署仍遵守推送、ECS拉取及`--expected-sha`校验流程。

## 验证

```bash
cd portal
node --test src/*.test.js
```

Node 版本需与现有 `better-sqlite3` 本机二进制匹配。新增测试覆盖上传完整性、Range播放、租约重入/过期、重试、凭据撤销、跨用户/游客/API权限、乐观并发编辑、文字与转写搜索、Markdown导出、API图文调用与截断失败，以及CLI工具隔离参数。
