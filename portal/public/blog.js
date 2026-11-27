(function() {
    var legacy = document.getElementById('blog-section');
    var host = document.getElementById('blog-app');
    var parent = legacy && legacy.parentNode;
    var before = legacy && legacy.nextSibling;
    var fallbackMarkup = legacy ? legacy.outerHTML : '';

    function restoreLegacy() {
        if (parent && fallbackMarkup) {
            var template = document.createElement('div');
            template.innerHTML = fallbackMarkup;
            parent.insertBefore(template.firstElementChild, before);
        }
        import('./blog-legacy.js?v=vue-fallback-1');
    }

    if (!host) {
        import('./blog-legacy.js?v=vue-fallback-1');
        return;
    }

    legacy?.remove();
    import('./generated/blog-page-view.js?v=blog-page-vue-1')
        .then(function(mod) { mod.mountBlogPage(host); })
        .catch(function(error) {
            console.error(error);
            host.replaceChildren();
            restoreLegacy();
        });
})();
