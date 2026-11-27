const params = new URLSearchParams(location.search);

function loadLegacy() {
  return import('./app.js?v=shared-startup-1');
}

if (params.get('legacy') === '1') {
  loadLegacy().catch((error) => console.error(error));
} else {
  import('./generated/dip-page.js?v=vue-page-1')
    .then((module) => module.mountDipPage())
    .catch((error) => {
      console.error('Vue 抄底页加载失败，回退旧脚本', error);
      loadLegacy().catch((legacyError) => console.error(legacyError));
    });
}
