import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATE_FILE = fileURLToPath(new URL('../data/company-monitor-state.json', import.meta.url));

export function fingerprint(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

export function loadCompanyMonitorSnapshot(filePath = DEFAULT_STATE_FILE) {
    try {
        var snapshot = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (snapshot.version !== 1 || !snapshot.watchers || typeof snapshot.watchers !== 'object') {
            throw new Error('公司监听状态文件格式无效');
        }
        return snapshot.watchers;
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw new Error('读取公司监听持久化状态失败：' + err.message);
    }
}

export function saveCompanyMonitorSnapshot(watchers, filePath = DEFAULT_STATE_FILE) {
    var directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    var temporaryPath = filePath + '.' + process.pid + '.tmp';
    var snapshot = JSON.stringify({ version: 1, watchers: watchers }, null, 2) + '\n';
    fs.writeFileSync(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
}

export { DEFAULT_STATE_FILE };
