import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICLIST_ROOT = process.env.PICLIST_ROOT || path.resolve(__dirname, '../../piclist');
const CONFIG_PATH = process.env.PICLIST_CONFIG_PATH || path.join(PICLIST_ROOT, 'data', 'config.json');
const ENV_PATH = process.env.PICLIST_ENV_PATH || path.join(PICLIST_ROOT, '.env');

function currentUploader(doc) {
    return doc?.picBed?.current || doc?.picBed?.uploader || '';
}

function currentProfile(doc) {
    var uploader = currentUploader(doc);
    return uploader && doc?.picBed?.[uploader] && typeof doc.picBed[uploader] === 'object'
        ? doc.picBed[uploader]
        : {};
}

function hasEnvValue(key) {
    if (!fs.existsSync(ENV_PATH)) return false;
    var line = fs.readFileSync(ENV_PATH, 'utf8')
        .split(/\r?\n/)
        .find(function(item) { return item.trim().startsWith(key + '='); });
    return !!(line && line.slice(line.indexOf('=') + 1).trim());
}

export function publicPiclistConfig(doc) {
    var uploader = currentUploader(doc);
    var profile = currentProfile(doc);
    return {
        uploader: uploader,
        configName: profile._configName || '',
        bucketName: profile.bucketName || '',
        region: profile.region || '',
        endpoint: profile.endpoint || '',
        urlPrefix: profile.urlPrefix || '',
        uploadPath: profile.uploadPath || '',
        acl: profile.acl || '',
        pathStyleAccess: profile.pathStyleAccess !== false,
        disableBucketPrefixToURL: profile.disableBucketPrefixToURL !== false,
        accessKeyConfigured: !!profile.accessKeyID,
        secretKeyConfigured: !!profile.secretAccessKey,
        serverKeyConfigured: hasEnvValue('PICLIST_SERVER_KEY'),
        renamePluginEnabled: doc?.picgoPlugins?.['picgo-plugin-datetime-rename'] === true
    };
}

export function readPiclistConfig() {
    if (!fs.existsSync(CONFIG_PATH)) throw new Error('未找到 PicList 配置文件');
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function cleanText(value, name, options) {
    var opts = options || {};
    if (value == null) {
        if (opts.required) throw new Error(name + '不能为空');
        return undefined;
    }
    if (typeof value !== 'string') throw new Error(name + '格式不正确');
    var out = value.trim();
    if (opts.required && !out) throw new Error(name + '不能为空');
    if (out.length > (opts.max || 500)) throw new Error(name + '过长');
    return out;
}

function cleanUrl(value, name) {
    var out = cleanText(value, name, { required: true, max: 1000 });
    var parsed;
    try { parsed = new URL(out); }
    catch (err) { throw new Error(name + '不是合法 URL'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(name + '仅支持 HTTP/HTTPS');
    }
    if (parsed.username || parsed.password) throw new Error(name + '不能包含账号密码');
    return out.replace(/\/$/, '');
}

export function applyPiclistConfigPatch(doc, input) {
    var body = input && typeof input === 'object' ? input : {};
    var uploader = currentUploader(doc);
    if (!uploader) throw new Error('PicList 未配置当前上传器');
    var profile = currentProfile(doc);
    var next = Object.assign({}, profile);

    next.bucketName = cleanText(body.bucketName, '桶名称', { required: true, max: 200 });
    next.region = cleanText(body.region, '区域', { required: true, max: 100 });
    next.endpoint = cleanUrl(body.endpoint, 'S3 端点');
    next.urlPrefix = cleanUrl(body.urlPrefix, '外链前缀');
    next.uploadPath = cleanText(body.uploadPath, '上传路径', { max: 500 }) || '';
    next.acl = cleanText(body.acl, 'ACL', { max: 100 }) || '';
    if (typeof body.pathStyleAccess === 'boolean') next.pathStyleAccess = body.pathStyleAccess;
    if (typeof body.disableBucketPrefixToURL === 'boolean') {
        next.disableBucketPrefixToURL = body.disableBucketPrefixToURL;
    }

    var accessKeyID = cleanText(body.accessKeyID, 'Access Key ID', { max: 500 });
    var secretAccessKey = cleanText(body.secretAccessKey, 'Secret Access Key', { max: 1000 });
    if (accessKeyID) next.accessKeyID = accessKeyID;
    if (secretAccessKey) next.secretAccessKey = secretAccessKey;

    doc.picBed[uploader] = next;
    if (!doc.picgoPlugins || typeof doc.picgoPlugins !== 'object') doc.picgoPlugins = {};
    if (typeof body.renamePluginEnabled === 'boolean') {
        doc.picgoPlugins['picgo-plugin-datetime-rename'] = body.renamePluginEnabled;
    }

    var uploaderConfig = doc?.uploader?.[uploader];
    if (uploaderConfig && Array.isArray(uploaderConfig.configList)) {
        var matchId = next._id || uploaderConfig.defaultId;
        var found = false;
        uploaderConfig.configList = uploaderConfig.configList.map(function(item) {
            if (!found && (!matchId || item._id === matchId)) {
                found = true;
                return Object.assign({}, item, next);
            }
            return item;
        });
        if (!found) uploaderConfig.configList.push(Object.assign({}, next));
    }
    return doc;
}

export function savePiclistConfig(input) {
    var doc = applyPiclistConfigPatch(readPiclistConfig(), input);
    var tempPath = CONFIG_PATH + '.tmp-' + process.pid;
    fs.writeFileSync(tempPath, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, CONFIG_PATH);
    return publicPiclistConfig(doc);
}

async function inspectContainer() {
    try {
        var result = await execFileAsync('docker', [
            'inspect', 'piclist', '--format', '{{json .State}}'
        ], { timeout: 5000, windowsHide: true });
        var state = JSON.parse(result.stdout.trim());
        return {
            available: true,
            status: state.Status || 'unknown',
            running: !!state.Running,
            health: state.Health?.Status || null,
            startedAt: state.StartedAt || null,
            restartCount: state.RestartCount || 0
        };
    } catch (err) {
        return { available: false, status: 'unknown', error: '无法读取容器状态' };
    }
}

async function probeHttp(internalUrl) {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 5000);
    var started = Date.now();
    try {
        var response = await fetch(new URL('/', internalUrl), {
            method: 'GET',
            signal: controller.signal,
            headers: { Accept: 'text/html' }
        });
        await response.arrayBuffer();
        return { ok: response.ok, status: response.status, latencyMs: Date.now() - started };
    } catch (err) {
        return { ok: false, status: null, latencyMs: Date.now() - started, error: 'PicList HTTP 服务不可达' };
    } finally {
        clearTimeout(timer);
    }
}

export async function getPiclistStatus(service) {
    var config = null;
    var configError = null;
    try { config = publicPiclistConfig(readPiclistConfig()); }
    catch (err) { configError = err.message; }
    var results = await Promise.all([
        probeHttp(service.internalUrl),
        inspectContainer()
    ]);
    return {
        checkedAt: new Date().toISOString(),
        http: results[0],
        container: results[1],
        config: config,
        configError: configError
    };
}

export async function restartPiclist() {
    await execFileAsync('docker', ['restart', 'piclist'], { timeout: 30000, windowsHide: true });
    return { restartedAt: new Date().toISOString() };
}
