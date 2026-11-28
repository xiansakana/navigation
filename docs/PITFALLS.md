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
