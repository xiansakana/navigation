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
    }
});
