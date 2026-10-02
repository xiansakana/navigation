(function() {
    var section = document.getElementById('blog-section');
    var feed = document.getElementById('blog-feed');
    var composer = document.getElementById('blog-composer');
    var input = document.getElementById('blog-content');
    var fileInput = document.getElementById('blog-images');
    var preview = document.getElementById('blog-preview');
    var more = document.getElementById('blog-more');
    var shortcut = document.getElementById('blog-shortcut');
    var state = { userId: '', canPost: false, canManage: false, lastId: null, loading: false,
        pendingImages: [], posts: new Map(), editing: null };
    var allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    var maxImageSize = 5 * 1024 * 1024;

    async function request(path, options) {
        var response = await fetch('/api/blog/' + path, options || {});
        var data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || '请求失败');
        return data;
    }

    function readDataUrl(blob) {
        return new Promise(function(resolve, reject) {
            var reader = new FileReader();
            reader.onload = function() { resolve(reader.result); };
            reader.onerror = function() { reject(new Error('图片读取失败')); };
            reader.readAsDataURL(blob);
        });
    }

    function convertToJpeg(file) {
        return new Promise(function(resolve, reject) {
            var url = URL.createObjectURL(file);
            var image = new Image();
            image.onload = function() {
                URL.revokeObjectURL(url);
                var scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
                var canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                var context = canvas.getContext('2d');
                if (!context) return reject(new Error('浏览器无法处理这张图片'));
                context.fillStyle = '#fff';
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                canvas.toBlob(function(blob) {
                    if (blob) resolve(blob);
                    else reject(new Error('图片转换失败'));
                }, 'image/jpeg', 0.85);
            };
            image.onerror = function() {
                URL.revokeObjectURL(url);
                reject(new Error('无法识别此图片，请换用 JPG、PNG 或 WebP'));
            };
            image.src = url;
        });
    }

    async function prepareImage(file) {
        if (!file.type.startsWith('image/') && !/\.(heic|heif|jpe?g|png|webp|gif)$/i.test(file.name)) {
            throw new Error('请选择图片文件');
        }
        var blob = allowedTypes.includes(file.type) && file.size <= maxImageSize
            ? file : await convertToJpeg(file);
        if (blob.size > maxImageSize) throw new Error('图片处理后仍超过 5MB');
        var dataUrl = await readDataUrl(blob);
        return { mime: blob.type, data: dataUrl.slice(dataUrl.indexOf(',') + 1), preview: dataUrl };
    }

    async function addImages(files, target, render, limit) {
        if (target.length + files.length > (limit == null ? 4 : limit)) throw new Error('每篇最多 4 张图片');
        var prepared = [];
        for (var i = 0; i < files.length; i++) prepared.push(await prepareImage(files[i]));
        prepared.forEach(function(image) { target.push(image); });
        render();
    }

    function imageTile(src, alt, removeAction) {
        var tile = document.createElement('div');
        tile.className = 'blog-image-tile';
        var image = document.createElement('img');
        image.src = src;
        image.alt = alt;
        image.loading = 'lazy';
        tile.appendChild(image);
        if (removeAction) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'blog-image-remove';
            button.textContent = '×';
            button.setAttribute('aria-label', '移除图片');
            Object.keys(removeAction).forEach(function(key) { button.dataset[key] = removeAction[key]; });
            tile.appendChild(button);
        }
        return tile;
    }

    function renderComposerPreview() {
        preview.replaceChildren();
        state.pendingImages.forEach(function(image, index) {
            preview.appendChild(imageTile(image.preview, '待发布图片 ' + (index + 1), { action: 'remove-pending', index: index }));
        });
    }

    function renderEditPreview(article) {
        var editing = state.editing;
        var root = article.querySelector('.blog-edit-preview');
        root.replaceChildren();
        var post = state.posts.get(editing.id);
        (post.images || []).filter(function(image) { return editing.keepImageIds.includes(image.id); })
            .forEach(function(image) {
                root.appendChild(imageTile(image.url, '已有图片', { action: 'remove-image', source: 'existing', imageId: image.id }));
            });
        editing.pending.forEach(function(image, index) {
            root.appendChild(imageTile(image.preview, '新图片 ' + (index + 1), { action: 'remove-image', source: 'pending', index: index }));
        });
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
        if (post.images && post.images.length) {
            var gallery = document.createElement('div');
            gallery.className = 'blog-post-images';
            post.images.forEach(function(image, index) {
                var link = document.createElement('a');
                link.href = image.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.setAttribute('aria-label', '查看第 ' + (index + 1) + ' 张图片');
                link.appendChild(imageTile(image.url, '博客图片 ' + (index + 1)));
                gallery.appendChild(link);
            });
            main.appendChild(gallery);
        }
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
            if (reset) state.posts.clear();
            state.userId = data.userId;
            state.canPost = data.canPost;
            state.canManage = data.canManage;
            composer.classList.toggle('hidden', !state.canPost);
            shortcut.textContent = state.canPost ? '写博客' : '查看动态';
            shortcut.classList.remove('hidden');
            data.posts.forEach(function(post) {
                state.posts.set(post.id, post);
                feed.appendChild(renderPost(post));
            });
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
    fileInput.addEventListener('change', async function() {
        try { await addImages(Array.from(fileInput.files), state.pendingImages, renderComposerPreview); }
        catch (error) { window.portalToast?.error(error.message); }
        fileInput.value = '';
    });
    preview.addEventListener('click', function(event) {
        var button = event.target.closest('button[data-action="remove-pending"]');
        if (!button) return;
        state.pendingImages.splice(Number(button.dataset.index), 1);
        renderComposerPreview();
    });
    composer.addEventListener('submit', async function(event) {
        event.preventDefault();
        if (!input.value.trim() && !state.pendingImages.length) {
            window.portalToast?.error('请输入博客内容或添加图片');
            return;
        }
        var button = document.getElementById('blog-submit');
        button.disabled = true;
        try {
            await request('posts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: input.value, images: state.pendingImages.map(function(image) { return { mime: image.mime, data: image.data }; }) }) });
            input.value = '';
            state.pendingImages = [];
            renderComposerPreview();
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
                state.editing = null;
                await load(true);
            } catch (error) { window.portalToast?.error(error.message); }
            return;
        }
        if (state.editing) {
            window.portalToast?.warn('请先完成当前编辑');
            return;
        }
        var post = state.posts.get(button.dataset.id);
        state.editing = { id: post.id, keepImageIds: (post.images || []).map(function(image) { return image.id; }), pending: [] };
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
        var oldGallery = article.querySelector('.blog-post-images');
        if (oldGallery) oldGallery.remove();
        var tools = document.createElement('div');
        tools.className = 'blog-edit-tools';
        var editPreview = document.createElement('div');
        editPreview.className = 'blog-image-preview blog-edit-preview';
        var editInput = document.createElement('input');
        editInput.type = 'file';
        editInput.accept = 'image/*';
        editInput.multiple = true;
        editInput.hidden = true;
        editInput.id = 'blog-edit-images-' + post.id;
        editInput.dataset.editImages = post.id;
        var label = document.createElement('label');
        label.className = 'btn ghost blog-upload-label';
        label.htmlFor = editInput.id;
        label.textContent = '📷 添加图片';
        tools.append(editPreview, label, editInput);
        actions.before(tools);
        actions.replaceChildren(save, cancel);
        renderEditPreview(article);
        editor.focus();
    });
    feed.addEventListener('click', async function(event) {
        var button = event.target.closest('button[data-action="save"], button[data-action="cancel"]');
        if (!button) return;
        if (button.dataset.action === 'cancel') {
            state.editing = null;
            return load(true);
        }
        try {
            var editing = state.editing;
            await request('posts/' + button.dataset.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: button.closest('.blog-post').querySelector('textarea').value,
                    keepImageIds: editing.keepImageIds,
                    images: editing.pending.map(function(image) { return { mime: image.mime, data: image.data }; }) }) });
            state.editing = null;
            await load(true);
        } catch (error) { window.portalToast?.error(error.message); }
    });
    feed.addEventListener('change', async function(event) {
        var chooser = event.target.closest('input[data-edit-images]');
        if (!chooser || !state.editing || chooser.dataset.editImages !== state.editing.id) return;
        try {
            await addImages(Array.from(chooser.files), state.editing.pending,
                function() { renderEditPreview(chooser.closest('.blog-post')); }, 4 - state.editing.keepImageIds.length);
        } catch (error) { window.portalToast?.error(error.message); }
        chooser.value = '';
    });
    feed.addEventListener('click', function(event) {
        var button = event.target.closest('button[data-action="remove-image"]');
        if (!button || !state.editing) return;
        if (button.dataset.source === 'existing') {
            state.editing.keepImageIds = state.editing.keepImageIds.filter(function(id) { return id !== button.dataset.imageId; });
        } else {
            state.editing.pending.splice(Number(button.dataset.index), 1);
        }
        renderEditPreview(button.closest('.blog-post'));
    });
    more.addEventListener('click', function() { load(false); });
    shortcut.addEventListener('click', function() {
        if (state.canPost) setTimeout(function() { input.focus(); }, 0);
    });
    load(true);
})();
