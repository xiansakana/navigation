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

## 2026-11-28 · 流量序列画 K 线会变成「条形码」

**现象**：记账「收支走势」改成 K 线后，收入/净支出的蜡烛全是从 0 到峰值的细长竖线，和累计结余（百万级）挤在一根 y 轴上，几乎看不见。

**根因**：收入/支出是**流量**（每月合计），开高低收没有金融含义——open 常是 0、close 也是 0、high 是当月某天的峰值，画出来就是一根竖线。再加上量级差 80 倍，同一根轴必然压扁。

**修复**：K 线模式只画**存量**序列（累计结余/资产余额/收益），流量序列在图例里置灰并提示切折线；另加兜底——可见序列量级差超过 8 倍时，小量级序列单独走右轴。

**教训**：把折线改成 K 线前先问「这个量有开高低收吗」。存量（余额、累计收益、净值）可以，流量（当日/当月发生额）不行；量级差异大的多序列必须分轴，否则默认视图就是坏的。

## 2026-11-28 · 生成产物的 `?v=` 写死会让用户看不到新代码

**现象**：股票页 K 线本地正常、部署也成功，但线上仍显示旧折线（若无登录检查根本发现不了）。

**根因**：`stock-manage/public/app-vue.js` 里 `import('./generated/holdings-page.js?v=vue-page-1')` 与 `index.html` 的 `app-vue.js?v=vue-page-1` 都是写死的版本号，`generated/` 又被 gitignore、由部署时重新构建，URL 不变 → 浏览器直接用缓存里的旧包。

**修复**：改 `pnl-viz.js` 这类会被打进 generated 包的源文件时，同步把 `app-vue.js` 与 `index.html` 的版本号 +1（`vue-page-2`）。记账那边 `app.js` 用 `?epoch=` + `__bookkeepingViewEpoch` 动态破缓存，没有这个问题。

**教训**：判断「改动是否会被用户看到」要顺着入口 HTML 的 script 引用走一遍，看每个 `?v=` 是否会变；`curl` 到 200 不代表浏览器会重新下载。

## 2026-11-28 · Vue 写死的 value 会把用户选的「全部」改回「月」

**现象**：记账资产页顶部期间选择器点「全部」，按钮高亮和「全部日期」文案都变了，但再操作时又按「月」查询；刷新后也回到月。

**根因**：`bookkeeping-app-view.ts` 的隐藏输入是 `h('input',{id:'period-kind',value:'month'})`——`value` 是**静态 vnode 属性**。期间控制器是用 `el.value = kind` 命令式写入的，Vue 在任一次重渲染时 `patchDOMProp` 发现 `el.value !== 'month'`，就把值写回 `'month'`。于是 DOM 里出现“按钮 active=all、caption=全部日期、隐藏字段=month”的错位状态；`query()` 读的是隐藏字段，所以查询按 month 走。

**修复**：把 kind 和 anchor 提成 `ref`，输入框改成 `value: periodKind.value` / `value: periodAnchor.value`，并在控制器 `update()` 里同步回 ref；按钮 active 也改成读 ref。另补一条源码级回归测试，禁止再出现 `id:'period-kind', value:'month'`。

**教训**：
- 同一个输入只要有一处命令式写 `value`，vnode 里就不能再给静态 `value`，否则每次 patch 都会覆盖。
- 排查这类“点了没反应”优先看**隐藏字段的实际值**而不是按钮样式：样式是控制器写的，值可能已经被框架改回去了。用 `Object.defineProperty` 拦截 `value` 的 setter 打印调用栈，一眼能看出是谁改的。

