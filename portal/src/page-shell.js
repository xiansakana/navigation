const pageAsset = '/portal-page.js?v=2';
const scopeAsset = '/data-scope.js?v=1';
const navbarAsset = '/navbar-dropdown.js?v=9';

export function injectPageScripts(html) {
    const scripts = [pageAsset, scopeAsset, navbarAsset]
        .filter((src) => !html.includes(`src="${src}"`))
        .map((src) => `<script defer src="${src}"></script>`).join('');
    return scripts ? html.replace(/<\/head>/i, () => scripts + '</head>') : html;
}
