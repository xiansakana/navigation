document.getElementById('login-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var err = document.getElementById('error');
    err.hidden = true;
    try {
        var resp = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: document.getElementById('username').value.trim(),
                password: document.getElementById('password').value
            })
        });
        var data = await resp.json();
        if (!resp.ok || !data.ok) throw new Error(data.error || '登录失败');
        location.href = '/';
    } catch (error) {
        err.textContent = error.message;
        err.hidden = false;
        window.portalToast?.error(error.message);
    }
});

(function initOAuth() {
    var err = document.getElementById('error');
    var params = new URLSearchParams(location.search);
    var oauthError = params.get('error');
    if (oauthError) {
        err.textContent = oauthError;
        err.hidden = false;
        window.portalToast?.error(oauthError);
    }

    fetch('/api/oauth/providers').then(function(resp) {
        return resp.json();
    }).then(function(data) {
        var providers = (data && data.providers) || [];
        if (!providers.length) return;
        var wrap = document.getElementById('oauth-buttons');
        var divider = document.getElementById('oauth-divider');
        wrap.hidden = false;
        divider.hidden = false;
        providers.forEach(function(provider) {
            var btn = document.createElement('a');
            btn.className = 'btn oauth-btn oauth-btn--' + provider.id;
            btn.href = '/api/oauth/' + provider.id + '/start';
            btn.textContent = '使用 ' + provider.label + ' 登录';
            wrap.appendChild(btn);
        });
    }).catch(function() {
        // OAuth 未配置时忽略
    });
})();
