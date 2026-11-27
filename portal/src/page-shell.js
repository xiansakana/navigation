const pageAsset = '/portal-page.js?v=2';
const scopeAsset = '/data-scope.js?v=1';
const navbarAsset = '/navbar-dropdown.js?v=9';
const sharedAssets = ['/ui/input-guard.js?v=20261011-2', '/ui/back-to-top.js?v=1'];

export function injectPageScripts(html) {
    const installedSharedAssets = new Set(Array.from(
        html.matchAll(/<script\b[^>]*?\s+src\s*=\s*["'](\/ui\/[^"'?]+)(?:\?[^"']*)?["']/gi),
        match => match[1]
    ));
    const scripts = [
        ...sharedAssets.filter(src => !installedSharedAssets.has(src.split('?')[0])),
        ...[pageAsset, scopeAsset, navbarAsset].filter(src => !html.includes(`src="${src}"`))
    ]
        .map((src) => `<script defer src="${src}"></script>`).join('');
    return scripts ? html.replace(/<\/head>/i, () => scripts + '</head>') : html;
}
