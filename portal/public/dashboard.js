async function api(path, options) {
    var resp = await fetch('/api/' + path, options || {});
    if (resp.status === 401) {
        location.href = '/login.html';
        throw new Error('未登录');
    }
    var data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error(data.error || resp.statusText);
    return data;
}

var visibleServices = [];

function renderServices(services) {
    var grid = document.getElementById('service-grid');
    grid.innerHTML = '';
    services.forEach(function(service) {
        var card = document.createElement('a');
        card.className = 'service-card';
        var href = service.path || service.url || '#';
        card.href = href;
        if (service.newTab) {
            card.target = '_blank';
            card.rel = 'noopener noreferrer';
        }
        card.innerHTML = '<div class="icon">' + (service.icon || '📦') + '</div>'
            + '<h2>' + service.title + '</h2>'
            + '<p>' + (service.description || '') + '</p>'
            + '<span class="tag">' + (service.type === 'proxy' || service.type === 'hub' ? '内置' : '外链') + '</span>';
        grid.appendChild(card);
    });
    document.getElementById('service-search-status').textContent = '显示 ' + services.length + ' 项服务';
    if (!services.length) {
        var empty = document.createElement('p');
        empty.className = 'service-empty';
        empty.textContent = visibleServices.length ? '没有找到匹配的服务，请尝试其他关键词。' : '当前账号暂无可访问的服务。';
        grid.appendChild(empty);
    }
}

document.getElementById('service-search').addEventListener('input', function(event) {
    var keyword = event.target.value.trim().toLocaleLowerCase();
    renderServices(visibleServices.filter(function(service) {
        return (service.title + ' ' + (service.description || '')).toLocaleLowerCase().includes(keyword);
    }));
});

document.getElementById('logout').addEventListener('click', function() {
    var btn = document.getElementById('logout');
    if (btn.dataset.mode === 'login') {
        location.href = '/login.html';
        return;
    }
    api('logout', { method: 'POST' }).finally(function() {
        location.href = '/';
    });
});

api('me').then(function(data) {
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
    return api('services');
}).then(function(data) {
    visibleServices = data.services || [];
    document.getElementById('service-search').dispatchEvent(new Event('input'));
}).catch(function(err) {
    document.getElementById('welcome').textContent = '加载失败';
    document.getElementById('service-search-status').textContent = '服务加载失败，请刷新重试';
    window.portalToast?.error(err.message);
}).finally(function() { window.navigationSkeleton?.finish(); });
