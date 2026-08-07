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
            + '<span class="tag">' + (service.type === 'proxy' ? '内置' : '外链') + '</span>';
        grid.appendChild(card);
    });
}

document.getElementById('logout').addEventListener('click', function() {
    api('logout', { method: 'POST' }).finally(function() {
        location.href = '/login.html';
    });
});

api('me').then(function(data) {
    document.getElementById('welcome').textContent = '欢迎，' + data.username;
    if (data.canAdmin) {
        var adminLink = document.getElementById('admin-link');
        if (adminLink) adminLink.classList.remove('hidden');
    }
    return api('services');
}).then(function(data) {
    renderServices(data.services || []);
}).catch(function(err) {
    document.getElementById('welcome').textContent = '加载失败';
    window.portalToast?.error(err.message);
});
