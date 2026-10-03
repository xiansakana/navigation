(function() {
    var section = document.getElementById('blog-section');
    var feed = document.getElementById('blog-feed');
    var composer = document.getElementById('blog-composer');
    var input = document.getElementById('blog-content');
    var richEditor = window.createBlogEditor(input);
    var tagEditor = window.createBlogTags(document.getElementById('blog-tags'));
    var locationEditor = window.createBlogLocation(document.getElementById('blog-location'));
    var tagFilter = document.getElementById('blog-tag-filter');
    var searchInput = document.getElementById('blog-search');
    var searchStatus = document.getElementById('blog-search-status');
    var imageInput = document.getElementById('blog-images');
    var videoInput = document.getElementById('blog-videos');
    var preview = document.getElementById('blog-preview');
    var more = document.getElementById('blog-more');
    var loading = document.getElementById('blog-loading');
    var shortcut = document.getElementById('blog-shortcut');
    var state = { userId: '', canPost: false, canManage: false, lastId: null, loading: false,
        pending: [], posts: new Map(), editing: null, tag: '', tags: [], search: '', refreshPending: false };

    async function request(path, options) {
        var response = await fetch('/api/blog/' + path, options || {});
        var data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || '请求失败');
        return data;
    }

    function convertToJpeg(file) {
        return new Promise(function(resolve, reject) {
            var url = URL.createObjectURL(file);
            var image = new Image();
            image.onload = function() {
                URL.revokeObjectURL(url);
                var scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
                var canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                var context = canvas.getContext('2d');
                if (!context) return reject(new Error('浏览器无法处理这张图片'));
                context.fillStyle = '#fff';
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                canvas.toBlob(function(blob) {
                    if (blob) resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
                    else reject(new Error('图片转换失败'));
                }, 'image/jpeg', 0.82);
            };
            image.onerror = function() { URL.revokeObjectURL(url); reject(new Error('浏览器无法识别此图片')); };
            image.src = url;
        });
    }

    function release(items) { items.forEach(function(item) { URL.revokeObjectURL(item.preview); }); }

    async function addFiles(files, kind, target, render) {
        var added = [];
        try {
            for (var file of files) {
                if (kind === 'video' && !file.type) {
                    var extension = file.name.split('.').at(-1).toLowerCase();
                    var videoTypes = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
                    if (videoTypes[extension]) file = new File([file], file.name, { type: videoTypes[extension] });
                }
                if (kind === 'video' && !['video/mp4', 'video/webm', 'video/quicktime'].includes(file.type)) throw new Error('视频仅支持 MP4、WebM、MOV');
                if (kind === 'video' && file.size > 50 * 1024 * 1024) throw new Error('视频需在 50MB 以内');
                var payload = kind === 'image' ? await convertToJpeg(file) : file;
                added.push({ kind: kind, file: payload, preview: URL.createObjectURL(payload) });
            }
            target.push.apply(target, added);
            render();
        } catch (error) { release(added); throw error; }
    }

    function mediaTile(src, kind, removeAction) {
        var tile = document.createElement('div');
        tile.className = 'blog-image-tile';
        var media = document.createElement(kind === 'video' ? 'video' : 'img');
        media.src = src;
        if (kind === 'video') { media.controls = true; media.preload = 'metadata'; }
        else { media.alt = '博客图片'; media.loading = 'lazy'; }
        if (kind === 'image') {
            var open = document.createElement('button'); open.type = 'button'; open.className = 'blog-image-open';
            open.dataset.blogImage = src; open.setAttribute('aria-label', '预览图片'); open.appendChild(media); tile.appendChild(open);
        } else tile.appendChild(media);
        if (removeAction) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'blog-image-remove';
            button.textContent = '×';
            button.setAttribute('aria-label', '移除媒体');
            Object.keys(removeAction).forEach(function(key) { button.dataset[key] = removeAction[key]; });
            tile.appendChild(button);
        }
        return tile;
    }

    function renderPreview(root, existing, pending, existingAction, pendingAction) {
        root.replaceChildren();
        existing.forEach(function(item) { root.appendChild(mediaTile(item.url, item.kind, existingAction(item))); });
        pending.forEach(function(item, index) { root.appendChild(mediaTile(item.preview, item.kind, pendingAction(index))); });
    }

    function renderComposerPreview() {
        renderPreview(preview, [], state.pending, function() {}, function(index) { return { action: 'remove-pending', index: index }; });
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
        time.className = 'blog-published-time';
        time.textContent = '发布于 ' + new Date(post.createdAt).toLocaleString('zh-CN');
        meta.append(author, time);
        if (new Date(post.updatedAt).getTime() > new Date(post.createdAt).getTime()) {
            var editedTime = document.createElement('time');
            editedTime.className = 'blog-edited-time';
            editedTime.dateTime = post.updatedAt;
            editedTime.textContent = '最后编辑于 ' + new Date(post.updatedAt).toLocaleString('zh-CN');
            meta.appendChild(editedTime);
        }
        var body = document.createElement('div');
        body.className = 'blog-post-content';
        if (post.contentFormat === 'html' || post.contentFormat === 'markdown') { body.classList.add('blog-rich-content'); body.innerHTML = post.contentFormat === 'markdown' ? post.contentHtml : post.content; }
        else body.textContent = post.content;
        main.append(meta, body);
        if (post.location) {
            var location = document.createElement(post.location.latitude != null ? 'a' : 'span');
            location.className = 'blog-post-location';
            location.textContent = '📍 ' + (post.location.label || '正在解析位置地址…');
            if (post.location.latitude != null) {
                location.href = 'https://www.openstreetmap.org/?mlat=' + post.location.latitude + '&mlon=' + post.location.longitude + '#map=15/' + post.location.latitude + '/' + post.location.longitude;
                location.target = '_blank'; location.rel = 'noopener noreferrer';
            }
            main.appendChild(location);
            if (post.location.latitude != null) {
                main.appendChild(window.createBlogLocationSource());
                if (!post.location.label) window.resolveBlogAddress(post.location).then(function(label) {
                    if (!location.isConnected) return;
                    location.textContent = '📍 ' + (label || '地址暂不可用');
                    if (label) post.location.label = label;
                });
            }
        }
        var postTags = document.createElement('div');
        postTags.className = 'blog-post-tags';
        (post.tags || []).forEach(function(tag) {
            var tagButton = document.createElement('button'); tagButton.type = 'button'; tagButton.className = 'blog-tag';
            tagButton.textContent = '#' + tag; tagButton.dataset.tag = tag; postTags.appendChild(tagButton);
        });
        main.appendChild(postTags);
        var items = (post.images || []).map(function(item) { return Object.assign({ kind: 'image' }, item); })
            .concat((post.videos || []).map(function(item) { return Object.assign({ kind: 'video' }, item); }));
        if (items.length) {
            var gallery = document.createElement('div');
            gallery.className = 'blog-post-images';
            items.forEach(function(item) {
                if (item.kind === 'video') { gallery.appendChild(mediaTile(item.url, 'video')); return; }
                gallery.appendChild(mediaTile(item.url, 'image'));
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
        if (state.editing) return;
        if (state.loading) { if (reset) state.refreshPending = true; return; }
        var query = state.search, tag = state.tag;
        state.loading = true;
        more.disabled = true;
        loading.classList.remove('hidden');
        feed.setAttribute('aria-busy', 'true');
        searchStatus.textContent = '正在加载动态…';
        try {
            var params = new URLSearchParams();
            if (!reset && state.lastId) params.set('before', state.lastId);
            if (state.tag) params.set('tag', state.tag);
            if (query) params.set('q', query);
            var data = await request('posts?' + params.toString());
            if (query !== state.search || tag !== state.tag) return;
            state.tags = data.tags || [];
            tagEditor.suggestions(state.tags);
            renderTagFilter();
            if (reset) { feed.replaceChildren(); state.posts.clear(); }
            state.userId = data.userId;
            state.canPost = data.canPost;
            state.canManage = data.canManage;
            composer.classList.toggle('hidden', !(state.canPost || state.canManage));
            if (state.canPost || state.canManage) locationEditor.start();
            shortcut.textContent = state.canPost ? '写博客' : '查看动态';
            shortcut.classList.remove('hidden');
            data.posts.forEach(function(post) { state.posts.set(post.id, post); feed.appendChild(renderPost(post)); });
            if (reset && !data.posts.length) {
                var empty = document.createElement('p');
                empty.className = 'blog-empty';
                empty.textContent = state.search ? '没有找到匹配的博客，试试其他关键词或清空搜索。' : state.tag ? '这个标签下还没有动态。' : '还没有动态，写下第一篇吧。';
                feed.appendChild(empty);
            }
            state.lastId = data.posts.length ? data.posts.at(-1).id : null;
            more.classList.toggle('hidden', data.posts.length < 20);
            searchStatus.textContent = (state.search || state.tag ? '当前筛选' : '全部动态') + '：已显示 ' + state.posts.size + ' 篇' + (data.posts.length === 20 ? '，可加载更多' : '');
            section.classList.remove('hidden');
        } catch (error) {
            searchStatus.textContent = '加载失败，请重新输入关键词重试';
            if (error.message !== '无权查看博客') window.portalToast?.error('博客加载失败：' + error.message);
        } finally {
            state.loading = false;
            more.disabled = false;
            loading.classList.add('hidden');
            feed.setAttribute('aria-busy', 'false');
            if (state.refreshPending) { state.refreshPending = false; load(true); }
        }
    }

    var searchTimer;
    searchInput.addEventListener('input', function(event) {
        if (event.isComposing) return;
        if (state.editing) { searchInput.value = state.search; window.portalToast?.warn('请先完成当前编辑'); return; }
        state.search = searchInput.value.trim();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function() { load(true); }, 300);
    });

    async function uploadAll(id, items) {
        var uploaded = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            try {
                uploaded.push(await request('posts/' + id + '/media?kind=' + item.kind,
                    { method: 'POST', headers: { 'Content-Type': item.file.type }, body: item.file }));
            } catch (error) { error.uploaded = uploaded; throw error; }
        }
        return uploaded;
    }

    input.addEventListener('input', function() { document.getElementById('blog-count').textContent = richEditor.length() + ' / 10000'; });
    imageInput.addEventListener('change', async function() {
        try { await addFiles(Array.from(imageInput.files), 'image', state.pending, renderComposerPreview); }
        catch (error) { window.portalToast?.error(error.message); }
        imageInput.value = '';
    });
    videoInput.addEventListener('change', async function() {
        try { await addFiles(Array.from(videoInput.files), 'video', state.pending, renderComposerPreview); }
        catch (error) { window.portalToast?.error(error.message); }
        videoInput.value = '';
    });
    preview.addEventListener('click', function(event) {
        var button = event.target.closest('button[data-action="remove-pending"]');
        if (!button) return;
        release(state.pending.splice(Number(button.dataset.index), 1));
        renderComposerPreview();
    });
    composer.addEventListener('submit', async function(event) {
        event.preventDefault();
        if (richEditor.isEmpty() && !state.pending.length) { window.portalToast?.error('请输入博客内容或添加媒体'); return; }
        var button = document.getElementById('blog-submit');
        button.disabled = true;
        var created;
        try {
            created = await request('posts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: richEditor.content(), contentFormat: richEditor.format(), location: await locationEditor.value(), tags: tagEditor.value(), hasMedia: state.pending.length > 0 }) });
            await uploadAll(created.id, state.pending);
            release(state.pending);
            state.pending = [];
            richEditor.clear(); tagEditor.clear(); locationEditor.clear();
            input.dispatchEvent(new Event('input'));
            renderComposerPreview();
            await load(true);
            window.portalToast?.success('发布成功');
        } catch (error) {
            if (created && !error.uploaded?.length) {
                await request('posts/' + created.id, { method: 'DELETE' }).catch(function() {});
                window.portalToast?.error('上传失败，内容已保留在编辑框：' + error.message);
            } else if (created) {
                release(state.pending); state.pending = []; richEditor.clear(); tagEditor.clear(); locationEditor.clear();
                input.dispatchEvent(new Event('input')); renderComposerPreview();
                await load(true);
                window.portalToast?.error('媒体上传中断，已发布的内容可在编辑中继续补充：' + error.message);
            }
            else window.portalToast?.error(error.message);
        } finally { button.disabled = false; }
    });

    function editItems(post) {
        return (post.images || []).map(function(item) { return Object.assign({ kind: 'image' }, item); })
            .concat((post.videos || []).map(function(item) { return Object.assign({ kind: 'video' }, item); }));
    }

    function renderEditPreview(article) {
        var editing = state.editing;
        var root = article.querySelector('.blog-edit-preview');
        var existing = editItems(state.posts.get(editing.id)).filter(function(item) { return editing.keepMediaIds.includes(item.id); });
        renderPreview(root, existing, editing.pending,
            function(item) { return { action: 'remove-media', source: 'existing', mediaId: item.id }; },
            function(index) { return { action: 'remove-media', source: 'pending', index: index }; });
    }

    feed.addEventListener('click', async function(event) {
        var button = event.target.closest('button[data-action="edit"], button[data-action="delete"]');
        if (!button) return;
        var article = button.closest('.blog-post');
        if (button.dataset.action === 'delete') {
            if (!confirm('确定删除这篇动态吗？')) return;
            try { await request('posts/' + button.dataset.id, { method: 'DELETE' }); state.editing?.editor.destroy(); state.editing = null; await load(true); }
            catch (error) { window.portalToast?.error(error.message); }
            return;
        }
        if (state.editing) { window.portalToast?.warn('请先完成当前编辑'); return; }
        var post = state.posts.get(button.dataset.id);
        state.editing = { id: post.id, keepMediaIds: editItems(post).map(function(item) { return item.id; }), pending: [] };
        var body = article.querySelector('.blog-post-content');
        var editor = document.createElement('div');
        editor.className = 'blog-edit-host';
        body.replaceWith(editor);
        state.editing.editor = window.createBlogEditor(editor, post);
        article.querySelector('.blog-post-tags')?.remove();
        article.querySelector('.blog-post-location')?.remove();
        var editLocation = document.createElement('div'); editor.after(editLocation);
        state.editing.location = window.createBlogLocation(editLocation, post.location);
        state.editing.location.start();
        var editTags = document.createElement('div');
        editor.after(editTags);
        state.editing.tags = window.createBlogTags(editTags, post.tags, state.tags);
        article.querySelector('.blog-post-images')?.remove();
        var tools = document.createElement('div');
        tools.className = 'blog-edit-tools';
        var editPreview = document.createElement('div');
        editPreview.className = 'blog-image-preview blog-edit-preview';
        tools.appendChild(editPreview);
        [['image', '📷 添加图片', 'image/*,.heic,.heif'], ['video', '🎬 添加视频', 'video/mp4,video/webm,video/quicktime,.mov']]
            .forEach(function(spec) {
                var chooser = document.createElement('input');
                chooser.type = 'file'; chooser.accept = spec[2]; chooser.multiple = true; chooser.hidden = true;
                chooser.id = 'blog-edit-' + spec[0] + '-' + post.id;
                chooser.dataset.editKind = spec[0];
                var label = document.createElement('label');
                label.className = 'btn ghost blog-upload-label'; label.htmlFor = chooser.id; label.textContent = spec[1];
                tools.append(label, chooser);
            });
        var actions = article.querySelector('.blog-actions');
        actions.before(tools);
        actions.replaceChildren(actionButton('保存', 'save', post.id), actionButton('取消', 'cancel', post.id));
        renderEditPreview(article);
        state.editing.editor.focus();
    });

    feed.addEventListener('click', async function(event) {
        var button = event.target.closest('button[data-action="save"], button[data-action="cancel"]');
        if (!button) return;
        if (button.dataset.action === 'cancel') {
            release(state.editing.pending); state.editing.editor.destroy(); state.editing = null; return load(true);
        }
        button.disabled = true;
        try {
            var editing = state.editing;
            var tags = editing.tags.value();
            if (editing.editor.length() > 10000) throw new Error('博客内容最多 10000 字');
            var uploaded = await uploadAll(editing.id, editing.pending);
            editing.keepMediaIds.push.apply(editing.keepMediaIds, uploaded.map(function(item) { return item.id; }));
            release(editing.pending); editing.pending = [];
            await request('posts/' + editing.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: editing.editor.content(), contentFormat: editing.editor.format(), location: await editing.location.value(), tags: tags,
                    keepMediaIds: editing.keepMediaIds }) });
            release(editing.pending); editing.editor.destroy(); state.editing = null;
            await load(true);
        } catch (error) {
            if (error.uploaded?.length) {
                release(state.editing.pending); state.editing?.editor.destroy(); state.editing = null; await load(true);
                window.portalToast?.error('部分媒体已上传，请重新编辑文章：' + error.message);
            } else window.portalToast?.error(error.message);
        }
        finally { button.disabled = false; }
    });
    feed.addEventListener('change', async function(event) {
        var chooser = event.target.closest('input[data-edit-kind]');
        if (!chooser || !state.editing) return;
        try { await addFiles(Array.from(chooser.files), chooser.dataset.editKind, state.editing.pending,
            function() { renderEditPreview(chooser.closest('.blog-post')); }); }
        catch (error) { window.portalToast?.error(error.message); }
        chooser.value = '';
    });
    feed.addEventListener('click', function(event) {
        var button = event.target.closest('button[data-action="remove-media"]');
        if (!button || !state.editing) return;
        if (button.dataset.source === 'existing') {
            state.editing.keepMediaIds = state.editing.keepMediaIds.filter(function(id) { return id !== button.dataset.mediaId; });
        } else release(state.editing.pending.splice(Number(button.dataset.index), 1));
        renderEditPreview(button.closest('.blog-post'));
    });
    function renderTagFilter() {
        tagFilter.replaceChildren();
        [{ tag: '', count: null }].concat(state.tags).forEach(function(item) {
            var button = document.createElement('button'); button.type = 'button'; button.className = 'blog-tag';
            button.dataset.tag = item.tag;
            button.textContent = item.tag ? '#' + item.tag + ' (' + item.count + ')' : '全部动态';
            button.setAttribute('aria-pressed', String(state.tag === item.tag));
            tagFilter.appendChild(button);
        });
    }
    async function selectTag(event) {
        var button = event.target.closest('button[data-tag]');
        if (!button || state.loading) return;
        if (state.editing) { window.portalToast?.warn('请先完成当前编辑'); return; }
        state.tag = button.dataset.tag; await load(true);
    }
    tagFilter.addEventListener('click', selectTag);
    feed.addEventListener('click', selectTag);
    more.addEventListener('click', function() { load(false); });
    shortcut.addEventListener('click', function() { if (state.canPost) setTimeout(function() { richEditor.focus(); }, 0); });
    async function initialize() {
        try {
            var response = await fetch('/api/me');
            var user = await response.json();
            if (!response.ok || !user.ok) throw new Error(user.error || '无法获取博客权限');
            var permissions = user.permissions || [];
            var canView = permissions.includes('blog:feed:view') || (!user.isGuest
                && (permissions.includes('blog:post:edit') || permissions.includes('blog:manage:edit')));
            if (!canView) return;
            section.classList.remove('hidden');
            await load(true);
        } catch (error) { window.portalToast?.error('博客加载失败：' + error.message); }
    }
    initialize();
})();
