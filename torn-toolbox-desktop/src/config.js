import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LEGACY_PATH = path.resolve(ROOT, 'config.json');
const LEGACY_EXAMPLE = path.resolve(ROOT, 'config.example.json');

const SERVICE_FILES = {
    undercut: {
        path: path.resolve(ROOT, 'config.undercut.json'),
        example: path.resolve(ROOT, 'config.undercut.example.json')
    },
    company: {
        path: path.resolve(ROOT, 'config.company.json'),
        example: path.resolve(ROOT, 'config.company.example.json')
    }
};

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function extractFromLegacy(service) {
    if (!fs.existsSync(LEGACY_PATH)) return null;
    var legacy = readJson(LEGACY_PATH);
    if (service === 'undercut') {
        return {
            server: { ...legacy.server, port: legacy.server?.port || 8790 },
            undercut: legacy.undercut || {},
            notify: legacy.notify || {},
            tornApiKey: legacy.tornApiKey || ''
        };
    }
    return {
        server: { ...legacy.server, port: 8791 },
        company: legacy.company || {},
        notify: legacy.notify || {},
        tornApiKey: legacy.tornApiKey || ''
    };
}

export function loadServiceConfig(service) {
    var meta = SERVICE_FILES[service];
    if (!meta) throw new Error('未知服务: ' + service);

    if (fs.existsSync(meta.path)) {
        return readJson(meta.path);
    }

    var fromLegacy = extractFromLegacy(service);
    if (fromLegacy) return fromLegacy;

    if (fs.existsSync(meta.example)) {
        fs.copyFileSync(meta.example, meta.path);
        throw new Error('已创建 ' + path.basename(meta.path) + '，请编辑后重新启动');
    }

    if (fs.existsSync(LEGACY_EXAMPLE)) {
        fs.copyFileSync(LEGACY_EXAMPLE, LEGACY_PATH);
        throw new Error('已创建 config.json，请复制为 config.' + service + '.json 后重新启动');
    }

    throw new Error('未找到 config.' + service + '.json');
}

export function saveServiceConfig(service, config) {
    var meta = SERVICE_FILES[service];
    if (!meta) throw new Error('未知服务: ' + service);
    fs.writeFileSync(meta.path, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/** @deprecated 兼容旧代码 */
export function loadConfig() {
    return loadServiceConfig('undercut');
}

/** @deprecated 兼容旧代码 */
export function saveConfig(config) {
    saveServiceConfig('undercut', config);
}
