const host = document.getElementById('knowledge-app');
const legacy = document.getElementById('knowledge-legacy');
const dialog = document.getElementById('reanalysis-dialog');
const parent = legacy && legacy.parentNode;
const before = legacy && legacy.nextSibling;
const legacyMarkup = legacy ? legacy.outerHTML : '';
const dialogMarkup = dialog ? dialog.outerHTML : '';

function restoreLegacy() {
    if (parent && legacyMarkup) {
        const template = document.createElement('div');
        template.innerHTML = legacyMarkup;
        const restored = template.firstElementChild;
        if (restored) {
            restored.hidden = false;
            parent.insertBefore(restored, before);
        }
    }
    if (dialogMarkup && !document.getElementById('reanalysis-dialog')) {
        const template = document.createElement('div');
        template.innerHTML = dialogMarkup;
        document.body.insertBefore(template.firstElementChild, document.body.querySelector('script[src*="/knowledge/app.js"]'));
    }
    import('./app-legacy.js?v=vue-fallback-live-models-1');
}

if (!host) {
    import('./app-legacy.js?v=vue-fallback-live-models-1');
} else {
    legacy?.remove();
    dialog?.remove();
    import('../generated/knowledge-page-view.js?v=knowledge-page-vue-live-models-1')
        .then(mod => { mod.mountKnowledgePage(host); })
        .catch(error => {
            console.error(error);
            host.replaceChildren();
            restoreLegacy();
        });
}
