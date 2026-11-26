(function () {
    const reads = new Map();
    const scripts = new Map();

    function read(path) {
        if (!reads.has(path)) {
            const request = fetch(path).then(async (response) => {
                if (response.redirected && /^\/login(?:\/|\.html|$)/.test(new URL(response.url).pathname)) {
                    const error = new Error('请先登录');
                    error.status = 401;
                    throw error;
                }
                const data = await response.json();
                if (!response.ok || data.ok === false) {
                    const error = new Error(data.error || response.statusText);
                    error.status = response.status;
                    throw error;
                }
                return data;
            }).catch((error) => {
                reads.delete(path);
                throw error;
            });
            reads.set(path, request);
        }
        return reads.get(path);
    }

    function loadScript(src) {
        if (!scripts.has(src)) {
            const script = document.createElement('script');
            script.src = src;
            const request = new Promise((resolve, reject) => {
                script.onload = resolve;
                script.onerror = () => reject(new Error('组件加载失败，请稍后重试'));
                document.head.append(script);
            }).catch((error) => {
                script.remove();
                scripts.delete(src);
                throw error;
            });
            scripts.set(src, request);
        }
        return scripts.get(src);
    }

    window.portalPage = {
        user: () => read('/api/me'),
        services: () => read('/api/services'),
        loadScript
    };
})();
