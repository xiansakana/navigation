# 踩坑记录

## 2026-11-28 · 本地启动 Portal 必须替换占位 sessionSecret

**现象**：`cd portal && node src/server.js` 直接报错 `请配置至少32字符的独立随机 auth.sessionSecret`，进程起不来。

**根因**：`portal/config.json` 的 `auth.sessionSecret` 是本地占位值，`login-security.js` 明确拒绝 `change-me|example|replace-me` 及长度不足 32 的密钥。

**修复**：复制一份仅供本地预览的配置，改密钥后用环境变量指向它，绝不改真实 `config.json`、也不把预览配置提交 Git：

```bash
python -c "
import json, shutil
p = r'D:\code\navigation\portal\config.preview.json'
shutil.copyfile(r'D:\code\navigation\portal\config.json', p)
d = json.load(open(p, encoding='utf-8'))
d['auth']['sessionSecret'] = 'preview-only-' + 'a' * 40
d['server']['host'] = '127.0.0.1'
d['server']['port'] = 8080
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
"
cd /d/code/navigation/portal
PORTAL_CONFIG_PATH=/d/code/navigation/portal/config.preview.json node src/server.js
```

用完删除 `config.preview.json`。

**教训**：任何本地起服务的操作先看 `login-security.js` 的密钥校验规则；预览配置属于敏感文件，必须走 `.gitignore` 或会话结束即删。

## 2026-11-28 · 用 Chrome headless 验证窄屏会被最小视口误导

**现象**：`--window-size=390,844` 截出来的登录页卡片右侧被裁掉，看起来像 CSS 溢出 bug。

**根因**：这个版本的 headless Chrome 有最小视口宽度约 504px，设 390 实际渲染宽度仍是 504，截图按 390 裁切造成假象。

**修复**：用 `--window-size=504,900` 作为窄屏验证尺寸；或用 `--dump-dom` + `document.title=window.innerWidth` 先确认真实视口。

**教训**：移动端截图异常时第一步先验证 headless 真实视口，不要直接怀疑样式；配合 `data-theme` 强制浅色时要确认 `theme.js` 的 localStorage 生效，而非只改 HTML 属性。

## 2026-11-28 · 全量测试有一项环境性失败

**现象**：`npm test` 966 项中 1 项失败：`packaged setup detects existing Node using Windows PowerShell 5.1 and PowerShell 7...` 报 `spawn pwsh.exe ENOENT`。

**根因**：测试依赖 PowerShell 7（`pwsh.exe`），本机未安装；与被测代码无关。

**修复**：无需改代码；在装有 PowerShell 7 的机器重跑该项即可确认。

**教训**：报告测试结果时区分「代码回归」与「环境缺失」，不要把环境失败算进本次改动。

## 2026-11-28 · 构建清理把 esbuild 共享 chunk 删了，视图整块白屏

**现象**：`npm test` 里两个 Torn 视图测试报 `UI condition timeout`；`public/generated/torn-chain-view.js` 第一行 `import{...}from"./chunk-DOWNU2B2.js"`，而目录里没有任何 `chunk-*.js`。

**根因**：`scripts/build-vue.mjs` 在**每次构建前**删除 `chunk-*` 与历史入口文件。`build:views` 实际是三个 node 进程串行：第一个（16 个入口，`splitting: true`）产出共享 chunk；第二、三个只有一个入口，`splitting: false`，启动时先把上一个进程产出的 chunk 删掉，自己又不会再生成。结果所有引用该 chunk 的入口全部失效。

**修复**：把清理挪到 `await build()` **之后**，并且只删「没有任何输出文件引用」的 `chunk-*`（扫描目录内所有 js 的 `./chunk-xxx.js` 引用作为保护集）。同时补 `portal/src/generated-assets.test.js`，断言所有生成的入口引用的 chunk 都真实存在。

**教训**：
- 多进程串行构建里，任何「构建前清理」都可能删掉别的进程的产物；清理必须在构建后、基于实际引用关系做。
- 判断生成产物是否健康，不能只看入口文件在不在，要顺着一层 import 走到叶子。
- 部署脚本 `ecs-update.sh --only portal` 会跑 `npm run build:views`，所以这类 bug 只会在构建后的运行期暴露，本地必须实际构建一次再验证页面。

## 2026-11-28 · experience.css 用更高权重抢走按钮配色

**现象**：给 `portalDialog` 的危险按钮写 `.portal-dialog .btn.portal-dialog-danger { background:#d93a44 }`，浏览器算出来仍是主色蓝 `rgb(107,161,255)`，且 `background-image: none`。

**根因**：`experience.css` 里 `body.portal-experience :is(.btn.primary, .save-btn)` 的权重是 (0,3,1)，` :is()` 会取参数里最高的权重。设计层用 (0,3,0) 压不住，`.btn.primary` 的实色背景覆盖了设计层的渐变和危险色。

**修复**：危险按钮再加一条 `html body.portal-experience :is(.portal-dialog .btn.portal-dialog-danger)`（权重 0,4,2）。验证方式不是看截图，而是 `getComputedStyle` 把 `backgroundColor` 写进 `document.title` 再 `--dump-dom` 读出来。

**教训**：这个项目里 `:is()` + `body.portal-experience` 的组合权重普遍偏高，新增组件样式先算权重；颜色类问题优先用 `getComputedStyle` 取证，别凭截图猜。

## 2026-11-28 · 本机对生产做线上验证：绕代理 + CDP 开关 + 进程生命周期

**现象**：`curl https://saoyu.fun` 超时；Node 连 Chrome DevTools 报 `Received network error or non-101 status code`；分两条命令跑 CDP 时第二次连不上浏览器。

**根因/修复**：
1. 本机设了 `HTTP(S)_PROXY`，生产域名走代理不通 → 加 `--noproxy '*'`（curl）或 `--no-proxy-server`（Chrome）。
2. Chrome 111+ 的 DevTools WebSocket 需要 `--remote-allow-origins=*`，否则握手被拒。
3. 后台进程在工具调用结束时会被清理 → 启动浏览器、取 `webSocketDebuggerUrl`、跑 Node 脚本必须写在**同一条命令**里。

**教训**：线上验证一条命令跑完：`chrome --headless=new --no-proxy-server --remote-debugging-port=N --remote-allow-origins=* ... &` → sleep → `curl /json` 取 ws → 同一个 node 脚本里 `Runtime.evaluate` + `Page.captureScreenshot`。用 `Log.enable` + `Runtime.exceptionThrown` 收集控制台错误，比看截图更能证明脚本没崩。

