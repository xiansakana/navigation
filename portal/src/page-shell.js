const pageAsset = '/portal-page.js?v=2';
const paletteAsset = '/command-palette.js?v=1';
const scopeAsset = '/data-scope.js?v=1';
const navbarAsset = '/navbar-dropdown.js?v=9';
const designAsset = '/design.css?v=design-4';

// Runtime UI layer: dialog owns confirm/alert/prompt, toast owns transient
// notices, portal-ui is the facade every module should call. Injecting all
// three everywhere removes the "which page has which helper" trap that used
// to force modules onto native window.confirm.
const uiRuntimeAssets = ['/dialog.js?v=2', '/toast.js?v=2', '/portal-ui.js?v=1'];
const sharedAssets = ['/ui/input-guard.js?v=20261011-2', '/ui/back-to-top.js?v=1'];
const pageAssets = [pageAsset, paletteAsset, scopeAsset, navbarAsset];

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasScript(html, src) {
    const path = src.split('?')[0];
    const pattern = new RegExp(
        `<script\\b[^>]*?\\ssrc\\s*=\\s*["']${escapeRegExp(path)}(?:\\?[^"']*)?["']`,
        'i'
    );
    return pattern.test(html);
}

export function injectPageScripts(html) {
    const scripts = [...uiRuntimeAssets, ...sharedAssets, ...pageAssets]
        .filter(src => !hasScript(html, src))
        .map((src) => `<script defer src="${src}"></script>`).join('');
    const styles = html.includes('/design.css') ? '' : `<link rel="stylesheet" href="${designAsset}">`;
    const injected = styles + scripts;
    return injected ? html.replace(/<\/head>/i, () => injected + '</head>') : html;
}
