import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(__dirname, '../public/error.html');

var cachedTemplate = null;

function esc(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function loadTemplate() {
    if (!cachedTemplate) {
        cachedTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    }
    return cachedTemplate;
}

export function wantsJsonResponse(req, url) {
    if (url.pathname.startsWith('/api/')) return true;
    var method = (req.method || 'GET').toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        return true;
    }
    var dest = req.headers['sec-fetch-dest'];
    if (dest === 'document' || dest === 'iframe') return false;
    if (dest === 'empty') return true;
    var accept = String(req.headers.accept || '');
    if (accept.includes('text/html')) return false;
    if (accept.includes('application/json')) return true;
    return false;
}

export function renderErrorPage(options) {
    var status = options.status || 403;
    var title = options.title || '出错了';
    var message = options.message || '请求无法完成';
    var hint = options.hint || '';
    var showLogin = options.showLogin !== false;

    return loadTemplate()
        .replace(/\{\{STATUS\}\}/g, esc(status))
        .replace(/\{\{TITLE\}\}/g, esc(title))
        .replace(/\{\{MESSAGE\}\}/g, esc(message))
        .replace(/\{\{HINT\}\}/g, esc(hint))
        .replace(/\{\{HINT_CLASS\}\}/g, hint ? '' : ' hidden')
        .replace(/\{\{LOGIN_CLASS\}\}/g, showLogin ? '' : ' hidden');
}

export function sendHtml(res, status, html) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}
