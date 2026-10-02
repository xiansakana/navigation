(function() {
    var section = document.getElementById('blog-section');
    var feed = document.getElementById('blog-feed');
    var composer = document.getElementById('blog-composer');
    var input = document.getElementById('blog-content');
    var more = document.getElementById('blog-more');
    var state = { userId: '', canPost: false, canManage: false, lastId: null, loading: false };

    async function request(path, options) {
        var response = await fetch('/api/blog/' + path, options || {});
        var data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || '请求失败');
        return data;
    }

    function actionButton(label, action, id) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'blog-action';
        button.textContent = label;
        button.dataset.action = action;
        button.dataset.id = id;
        return button;
    }

    function renderPost(post) {
        var article = document.createElement('article');
        article.className = 'blog-post';
        article.dataset.id = post.id;
        var avatar = document.createElement('span');
        avatar.className = 'blog-avatar';
        avatar.textContent = (post.authorName || '?').slice(0, 1).toUpperCase();
        var main = document.createElement('div');
        main.className = 'blog-post-main';
        var meta = document.createElement('div');
        meta.className = 'blog-post-meta';
        var author = document.createElement('strong');
        author.textContent = post.authorName;
        var time = document.createElement('time');
        time.dateTime = post.createdAt;
        time.textContent = new Date(post.createdAt).toLocaleString('zh-CN');
        meta.append(author, time);
        var body = document.createElement('p');
        body.className = 'blog-post-content';
        body.textContent = post.content;
        main.append(meta, body);
        if (state.canManage || (state.canPost && post.authorId === state.userId)) {
            var actions = document.createElement('div');
            actions.className = 'blog-actions';
            actions.append(actionButton('编辑', 'edit', post.id), actionButton('删除', 'delete', post.id));
            main.append(actions);
        }
        article.append(avatar, main);
        return article;
    }

    async function load(reset) {
        if (state.loading) return;
        state.loading = true;
        more.disabled = true;
        try {
            var data = await request('posts' + (!reset && state.lastId ? '?before=' + state.lastId : ''));
            if (reset) feed.replaceChildren();
            state.userId = data.userId;
            state.canPost = data.canPost;
            state.canManage = data.canManage;
            composer.classList.toggle('hidden', !state.canPost);
            data.posts.forEach(function(post) { feed.appendChild(renderPost(post)); });
            if (reset && !data.posts.length) {
                var empty = document.createElement('p');
                empty.className = 'blog-empty';
                empty.textContent = '还没有动态，写下第一篇吧。';
                feed.appendChild(empty);
            }
            state.lastId = data.posts.length ? data.posts.at(-1).id : null;
            more.classList.toggle('hidden', data.posts.length < 20);
            section.classList.remove('hidden');
        } catch (error) {
            if (error.message !== '无权查看博客') window.portalToast?.error('博客加载失败：' + error.message);
        } finally {
            state.loading = false;
            more.disabled = false;
        }
    }

    input.addEventListener('input', function() {
        document.getElementById('blog-count').textContent = input.value.length + ' / 10000';
    });
    composer.addEventListener('submit', async function(event) {
        event.preventDefault();
        var button = document.getElementById('blog-submit');
        button.disabled = true;
        try {
            await request('posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: input.value }) });
            input.value = '';
            input.dispatchEvent(new Event('input'));
            await load(true);
            window.portalToast?.success('发布成功');
        } catch (error) { window.portalToast?.error(error.message); }
        finally { button.disabled = false; }
    });
    feed.addEventListener('click', async function(event) {
        var button = event.target.closest('button[data-action]');
        if (!button) return;
        if (button.dataset.action !== 'edit' && button.dataset.action !== 'delete') return;
        var article = button.closest('.blog-post');
        if (button.dataset.action === 'delete') {
            if (!confirm('确定删除这篇动态吗？')) return;
            try {
                await request('posts/' + button.dataset.id, { method: 'DELETE' });
                await load(true);
            } catch (error) { window.portalToast?.error(error.message); }
            return;
        }
        var body = article.querySelector('.blog-post-content');
        var editor = document.createElement('textarea');
        editor.className = 'blog-edit';
        editor.maxLength = 10000;
        editor.rows = 5;
        editor.value = body.textContent;
        var save = actionButton('保存', 'save', button.dataset.id);
        var cancel = actionButton('取消', 'cancel', button.dataset.id);
        var actions = article.querySelector('.blog-actions');
        body.replaceWith(editor);
        actions.replaceChildren(save, cancel);
        editor.focus();
    });
    feed.addEventListener('click', async function(event) {
        var button = event.target.closest('button[data-action="save"], button[data-action="cancel"]');
        if (!button) return;
        if (button.dataset.action === 'cancel') return load(true);
        try {
            await request('posts/' + button.dataset.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: button.closest('.blog-post').querySelector('textarea').value }) });
            await load(true);
        } catch (error) { window.portalToast?.error(error.message); }
    });
    more.addEventListener('click', function() { load(false); });
    load(true);
})();
