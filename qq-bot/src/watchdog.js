import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getStatus } from './napcat.js';

const execFileAsync = promisify(execFile);

function nowIso() {
    return new Date().toISOString();
}

function parseWatchdog(config) {
    const w = config.napcat?.watchdog || {};
    return {
        enabled: w.enabled === true,
        intervalMs: Number(w.intervalMs) > 0 ? Number(w.intervalMs) : 60_000,
        failBeforeRestart: Number(w.failBeforeRestart) > 0 ? Number(w.failBeforeRestart) : 2,
        cooldownMs: Number(w.cooldownMs) > 0 ? Number(w.cooldownMs) : 10 * 60_000,
        settleMs: Number(w.settleMs) > 0 ? Number(w.settleMs) : 45_000,
        restartCommand: Array.isArray(w.restartCommand) && w.restartCommand.length
            ? w.restartCommand.map(String)
            : ['docker', 'restart', 'napcat']
    };
}

async function isOnline(napcat) {
    const data = await getStatus(napcat.baseUrl, napcat.accessToken || '');
    const st = data?.data || data || {};
    return st.online === true || st.good === true;
}

async function restartNapCat(cmd) {
    const [bin, ...args] = cmd;
    await execFileAsync(bin, args, { timeout: 60_000 });
}

export function startLoginWatchdog(config) {
    const opts = parseWatchdog(config);
    if (!opts.enabled) return null;

    let failCount = 0;
    let lastRestartAt = 0;
    let lastOnline = null;
    let timer = null;
    let inFlight = false;

    async function tick() {
        if (inFlight) return;
        if (lastRestartAt && Date.now() - lastRestartAt < opts.settleMs) return;
        inFlight = true;
        try {
            const online = await isOnline(config.napcat);
            if (online) {
                if (lastOnline === false) {
                    console.log('[watchdog] NapCat QQ 已重新在线 ' + nowIso());
                }
                lastOnline = true;
                failCount = 0;
                return;
            }

            lastOnline = false;
            failCount += 1;
            const sinceRestart = Date.now() - lastRestartAt;
            console.warn('[watchdog] NapCat QQ 离线 (' + failCount + ') ' + nowIso());

            if (failCount < opts.failBeforeRestart) return;
            if (lastRestartAt && sinceRestart < opts.cooldownMs) {
                console.warn('[watchdog] 冷却中，暂不重启 NapCat');
                return;
            }

            console.warn('[watchdog] 尝试重启 NapCat 以触发快速/密码登录: ' + opts.restartCommand.join(' '));
            await restartNapCat(opts.restartCommand);
            lastRestartAt = Date.now();
            failCount = 0;
            console.warn('[watchdog] 已重启 NapCat，等待 ' + Math.round(opts.settleMs / 1000) + 's 后再检查');
        } catch (err) {
            lastOnline = false;
            failCount += 1;
            console.warn('[watchdog] 检查失败: ' + (err.message || err));
        } finally {
            inFlight = false;
        }
    }

    console.log('[watchdog] 已启用：每 ' + Math.round(opts.intervalMs / 1000) + 's 检查 QQ 在线状态，掉线后自动重启 NapCat');
    timer = setInterval(tick, opts.intervalMs);
    timer.unref?.();
    setTimeout(tick, 15_000).unref?.();

    return {
        stop() {
            if (timer) clearInterval(timer);
        }
    };
}
