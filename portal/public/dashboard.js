async function api(path, options) {
    var resp = await fetch('/api/' + path, options || {});
    if (resp.status === 401) {
        location.href = '/login/';
        throw new Error('未登录');
    }
    var data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error(data.error || resp.statusText);
    return data;
}

document.getElementById('logout').addEventListener('click', function() {
    var btn = document.getElementById('logout');
    if (btn.dataset.mode === 'login') {
        location.href = '/login/';
        return;
    }
    api('logout', { method: 'POST' }).finally(function() {
        location.href = '/';
    });
});

Promise.all([
    window.portalPage.user(),
    window.portalPage.services(),
    import('./generated/dashboard-view.js?v=1')
]).then(function([data, catalog, { mountServiceCatalog }]) {
    var logoutBtn = document.getElementById('logout');
    if (data.isGuest) {
        document.getElementById('welcome').textContent = '访客（guest 权限）';
        logoutBtn.textContent = '登录';
        logoutBtn.dataset.mode = 'login';
    } else {
        document.getElementById('welcome').textContent = '欢迎，' + data.username;
        logoutBtn.textContent = '退出登录';
        logoutBtn.dataset.mode = 'logout';
        if (data.canAdmin) {
            var adminLink = document.getElementById('admin-link');
            if (adminLink) adminLink.classList.remove('hidden');
        }
    }
    mountServiceCatalog(document.getElementById('service-grid'), document.getElementById('service-search'),
        document.getElementById('service-search-status'), catalog.services || []);
}).catch(function(err) {
    if (err.status === 401) { location.href = '/login/'; return; }
    document.getElementById('welcome').textContent = '加载失败';
    document.getElementById('service-search-status').textContent = '服务加载失败，请刷新重试';
    window.portalToast?.error(err.message);
}).finally(function() { window.navigationSkeleton?.finish(); });
