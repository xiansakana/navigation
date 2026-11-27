const host = document.getElementById('mingli-app');
const legacy = document.getElementById('mingli-legacy');
const parent = legacy && legacy.parentNode;
const before = legacy && legacy.nextSibling;
const fallbackMarkup = legacy ? legacy.outerHTML : '';

function restoreLegacy() {
  if (parent && fallbackMarkup) {
    const template = document.createElement('div');
    template.innerHTML = fallbackMarkup;
    const restored = template.firstElementChild;
    if (restored) {
      restored.hidden = false;
      parent.insertBefore(restored, before);
    }
  }
  import('./app-legacy.js?v=vue-fallback-1');
}

if (!host) {
  import('./app-legacy.js?v=vue-fallback-1');
} else {
  legacy?.remove();
  import('../generated/mingli-page-view.js?v=mingli-page-vue-1')
    .then(mod => { mod.mountMingliPage(host); })
    .catch(error => {
      console.error(error);
      host.replaceChildren();
      restoreLegacy();
    });
}
