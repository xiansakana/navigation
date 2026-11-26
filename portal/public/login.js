import('./generated/login-view.js?v=1').then(({ mountLoginView }) => {
    mountLoginView(document.getElementById('login-view'));
}).catch(() => {
    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');
    error.textContent = '登录页面加载失败，请刷新重试。';
    document.getElementById('login-view').replaceChildren(error);
    window.navigationSkeleton?.finish();
});
