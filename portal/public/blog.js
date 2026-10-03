(function() {
    var section = document.getElementById('blog-section');
    var feed = document.getElementById('blog-feed');
    var composer = document.getElementById('blog-composer');
    var input = document.getElementById('blog-content');
    var richEditor = window.createBlogEditor(input);
    var tagEditor = window.createBlogTags(document.getElementById('blog-tags'));
    var locationEditor = window.createBlogLocation(document.getElementById('blog-location'));
    var visibilityEditor = window.createBlogVisibility(document.getElementById('blog-visibility'));
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
        var data;
        try { data = await response.json(); }
        catch { throw new Error('请求失败（HTTP ' + response.status + '），请稍后重试'); }
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
                var payload = kind === 'image' ? await convertToJpeg(file) : file;
                added.push({ kind: kind, file: payload, preview: URL.createObjectURL(payload) });
            }
            target.push.apply(target, added);
            render();
        } catch (error) { release(added); throw error; }
    }

    function renderPreview(root, existing, pending, existingAction, pendingAction) {
        var list = existing.map(function(item) { return Object.assign({}, item, { removeAction: existingAction(item) }); });
        pending.forEach(function(item, index) { list.push({ url: item.preview, kind: item.kind, removeAction: pendingAction(index) }); });
        window.renderBlogGallery(root, list);
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
        var visibility = post.visibility || { audience: 'public' };
        var scope = document.createElement('span'); scope.className = 'blog-visibility-badge';
        scope.textContent = { public: '公开动态', members: '仅登录用户', self: '仅自己' }[visibility.audience];
        if (visibility.startsAt) scope.textContent += ' · ' + new Date(visibility.startsAt).toLocaleString('zh-CN') + ' 起可见';
        if (visibility.endsAt) scope.textContent += ' · ' + new Date(visibility.endsAt).toLocaleString('zh-CN') + ' 到期';
        if (visibility.startsAt && new Date(visibility.startsAt) > new Date()) scope.textContent += '（尚未开放）';
        if (visibility.endsAt && new Date(visibility.endsAt) <= new Date()) scope.textContent += '（已到期）';
        meta.appendChild(scope);
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
        var items = editItems(post);
        if (items.length) {
            var gallery = document.createElement('div'); gallery.className = 'blog-post-images';
            window.renderBlogGallery(gallery, items); main.appendChild(gallery);
        }
        if (state.canViewComments) {
            var comments = document.createElement('div'); comments.className = 'blog-comments';
            var toggle = actionButton('评论 (' + (post.commentCount || 0) + ')', 'comments', post.id);
            toggle.setAttribute('aria-expanded', 'false');
            var content = document.createElement('div'); content.className = 'blog-comments-content'; content.hidden = true;
            comments.append(toggle, content); main.appendChild(comments);
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
            state.isGuest = data.isGuest;
            state.canPost = data.canPost;
            state.canManage = data.canManage;
            state.canViewComments = data.canViewComments; state.canComment = data.canComment;
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

    async function uploadLargeVideo(id, item, position, progress) {
        var upload;
        try {
            progress('transfer', 0);
            upload = await request('posts/' + id + '/video-uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ size: item.file.size, mimeType: item.file.type, position: position }) });
            var count = Math.ceil(item.file.size / upload.chunkBytes);
            var loaded = new Array(count).fill(0);
            await window.runBlogUploads(Array.from({ length: count }, function(_, index) { return index + 1; }), async function(part) {
                var chunk = item.file.slice((part - 1) * upload.chunkBytes, part * upload.chunkBytes);
                for (var attempt = 0; ; attempt++) {
                    try {
                        await window.uploadBlogBytes('video-uploads/' + upload.id + '/parts/' + part, chunk, 'application/octet-stream', function(bytes) { loaded[part - 1] = bytes; progress('transfer', loaded.reduce(function(sum, value) { return sum + value; }, 0) / item.file.size * 100); });
                        break;
                    } catch (error) { if (attempt >= 2) throw error; }
                }

                return part;
            }, 2);
            await request('video-uploads/' + upload.id, { method: 'POST' });
            var errors = 0;
            for (;;) {
                var result;
                try { result = await request('video-uploads/' + upload.id); errors = 0; }
                catch (error) { if (++errors > 3) throw error; await new Promise(function(resolve) { setTimeout(resolve, 2000); }); continue; }
                if (result.state === 'failed') throw new Error(result.error || '视频处理失败');
                if (result.state === 'done') {
                    await request('video-uploads/' + upload.id, { method: 'DELETE' }).catch(function() {});
                    return result;
                }
                progress(result.state === 'queued' ? 'waiting' : result.state, result.progress);
                await new Promise(function(resolve) { setTimeout(resolve, 1200); });
            }
        } catch (error) {
            if (upload) await request('video-uploads/' + upload.id, { method: 'DELETE' }).catch(function() {});
            throw error;
        } finally { document.getElementById('blog-upload-status').textContent = ''; }
    }

    async function uploadAll(id, items, root) {
        var existing = state.posts.has(id) ? editItems(state.posts.get(id)) : [];
        var base = existing.reduce(function(max, item, index) { return Math.max(max, item.position == null ? index : item.position); }, -1) + 1;
        var panel = window.createBlogUploadProgress(root, items);
        var result = await window.runBlogUploads(items.slice(), async function(item, index) {
            var position = base + index;
            var progress = function(phase, percent) { panel.update(index, phase, percent); };
            var uploaded;
            try { uploaded = item.kind === 'video'
                ? await uploadLargeVideo(id, item, position, progress)
                : await window.uploadBlogBytes('posts/' + id + '/media?kind=image&position=' + position, item.file, item.file.type,
                    function(bytes) { progress(bytes >= item.file.size ? 'imageProcessing' : 'transfer', bytes / item.file.size * 100); }); }
            catch (error) { progress('failed', 0); throw error; }
            progress('done', 100); return uploaded;
        }, 2);
        panel.clear(); return result;
    }

    function lockEditor(root) {
        var controls = Array.from(root.querySelectorAll('button, input, select'));
        var disabled = controls.map(function(control) { return control.disabled; });
        var editable = Array.from(root.querySelectorAll('[contenteditable]'));
        var attributes = editable.map(function(control) { return control.getAttribute('contenteditable'); });
        controls.forEach(function(control) { control.disabled = true; });
        editable.forEach(function(control) { control.setAttribute('contenteditable', 'false'); });
        return function() {
            controls.forEach(function(control, index) { control.disabled = disabled[index]; });
            editable.forEach(function(control, index) { control.setAttribute('contenteditable', attributes[index]); });
        };
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
        if (state.saving || state.editing) { window.portalToast?.warn('请先完成当前编辑或上传'); return; }
        if (richEditor.isEmpty() && !state.pending.length) { window.portalToast?.error('请输入博客内容或添加媒体'); return; }
        state.saving = true;
        var button = document.getElementById('blog-submit');
        var unlock = lockEditor(composer);
        var created;
        try {
            created = await request('posts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: richEditor.content(), contentFormat: richEditor.format(), visibility: visibilityEditor.value(), location: await locationEditor.value({ wait: false }), tags: tagEditor.value(), hasMedia: state.pending.length > 0 }) });
            await uploadAll(created.id, state.pending, composer);
            release(state.pending);
            state.pending = [];
            richEditor.clear(); tagEditor.clear(); locationEditor.clear(); visibilityEditor.clear();
            input.dispatchEvent(new Event('input'));
            renderComposerPreview();
            await load(true);
            window.portalToast?.success('发布成功');
        } catch (error) {
            if (created && !error.uploaded?.length) {
                await request('posts/' + created.id, { method: 'DELETE' }).catch(function() {});
                window.portalToast?.error('上传失败，内容已保留在编辑框：' + error.message);
            } else if (created) {
                release(state.pending); state.pending = []; richEditor.clear(); tagEditor.clear(); locationEditor.clear(); visibilityEditor.clear();
                input.dispatchEvent(new Event('input')); renderComposerPreview();
                await load(true);
                window.portalToast?.error('媒体上传中断，已发布的内容可在编辑中继续补充：' + error.message);
            }
            else window.portalToast?.error(error.message);
        } finally { unlock(); state.saving = false; }
    });

    function editItems(post) {
        return (post.images || []).map(function(item) { return Object.assign({ kind: 'image' }, item); })
            .concat((post.videos || []).map(function(item) { return Object.assign({ kind: 'video' }, item); }))
            .sort(function(a, b) { return (a.position || 0) - (b.position || 0); });
    }

    var commentDrafts = new Map();
    async function renderComments(article, before) {
        var id = article.dataset.id, panel = article.querySelector('.blog-comments-content');
        var toggle = article.querySelector('[data-action="comments"]');
        panel.hidden = false; toggle.setAttribute('aria-expanded', 'true'); toggle.disabled = true;
        var indicator = document.createElement('p'); indicator.className = 'blog-comment-status'; indicator.textContent = '正在加载评论…'; indicator.setAttribute('role', 'status'); panel.appendChild(indicator);
        try {
            var data = await request('posts/' + id + '/comments' + (before ? '?before=' + before : ''));
            if (!before) panel.replaceChildren(); else panel.querySelector('[data-comment-more]')?.remove();
            data.comments.forEach(function(comment) {
                var row = document.createElement('div'); row.className = 'blog-comment'; row.dataset.commentId = comment.id;
                var meta = document.createElement('div'); meta.className = 'blog-comment-meta';
                var author = document.createElement('strong'); author.textContent = comment.authorName;
                var time = document.createElement('time'); time.dateTime = comment.createdAt; time.textContent = new Date(comment.createdAt).toLocaleString('zh-CN');
                meta.append(author, time);
                if (comment.canDelete) {
                    var remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除评论'; remove.className = 'blog-action';
                    remove.addEventListener('click', async function() {
                        if (!confirm('确定删除这条评论吗？')) return;
                        remove.disabled = true;
                        try { await request('comments/' + comment.id, { method: 'DELETE' }); await renderComments(article); }
                        catch (error) { window.portalToast?.error(error.message); remove.disabled = false; }
                    }); meta.appendChild(remove);
                }
                var text = document.createElement('div'); text.className = 'blog-comment-body';
                if (comment.contentFormat === 'markdown' && comment.contentHtml != null) { text.classList.add('blog-rich-content'); text.innerHTML = window.DOMPurify.sanitize(comment.contentHtml); }
                else text.textContent = comment.content;
                row.append(meta, text); panel.appendChild(row);
            });
            if (data.next) {
                var moreComments = document.createElement('button'); moreComments.type = 'button'; moreComments.className = 'blog-action'; moreComments.textContent = '加载更早的评论'; moreComments.dataset.commentMore = 'true';
                moreComments.addEventListener('click', function() { moreComments.disabled = true; renderComments(article, data.next); }); panel.appendChild(moreComments);
            }
            if (!panel.querySelector('.blog-comment')) { var empty = document.createElement('p'); empty.textContent = '还没有评论，聊聊你的想法。'; panel.appendChild(empty); }
            if (state.canComment && !panel.querySelector('form')) {
                var form = document.createElement('form'); form.className = 'blog-comment-form';
                var input = document.createElement('textarea'); input.maxLength = 2000; input.rows = 3; input.placeholder = '写下评论，支持 Markdown（加粗、列表、链接、代码等）…'; input.setAttribute('aria-label', '评论内容'); input.value = commentDrafts.get(id) || '';
                input.addEventListener('input', function() { commentDrafts.set(id, input.value); });
                var submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn primary'; submit.textContent = '发表评论';
                form.append(input, submit); panel.appendChild(form);
                form.addEventListener('submit', async function(event) {
                    event.preventDefault(); if (!input.value.trim()) return;
                    input.disabled = submit.disabled = true;
                    try { await request('posts/' + id + '/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: input.value }) }); commentDrafts.delete(id); await renderComments(article); }
                    catch (error) { window.portalToast?.error(error.message); input.disabled = submit.disabled = false; }
                });
            }
            toggle.textContent = '评论 (' + panel.querySelectorAll('.blog-comment').length + (data.next ? '+' : '') + ')';
        } catch (error) { indicator.textContent = '评论加载失败：' + error.message; window.portalToast?.error(error.message); }
        finally { if (indicator.textContent === '正在加载评论…') indicator.remove(); toggle.disabled = false; }
    }
    feed.addEventListener('click', function(event) {
        var toggle = event.target.closest('[data-action="comments"]'); if (!toggle) return;
        var article = toggle.closest('.blog-post'), panel = article.querySelector('.blog-comments-content');
        if (!panel.hidden) { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
        else renderComments(article);
    });

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
        if (state.saving) { window.portalToast?.warn('请等待当前上传完成'); return; }
        var article = button.closest('.blog-post');
        if (button.dataset.action === 'delete') {
            if (!confirm('确定删除这篇动态吗？')) return;
            try { var result = await request('posts/' + button.dataset.id, { method: 'DELETE' }); state.editing?.editor.destroy(); state.editing = null; await load(true); window.portalToast?.success(result.cleanupPending ? '已删除，媒体将在后台清理' : '已删除'); }
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
        var editVisibility = document.createElement('div'); editor.after(editVisibility);
        state.editing.visibility = window.createBlogVisibility(editVisibility, post.visibility);
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
        if (state.saving) return;
        state.saving = true;
        var unlock = lockEditor(button.closest('.blog-post'));
        try {
            var editing = state.editing;
            var tags = editing.tags.value();
            var visibility = editing.visibility.value();
            if (editing.editor.length() > 10000) throw new Error('博客内容最多 10000 字');
            var uploaded = await uploadAll(editing.id, editing.pending, button.closest('.blog-post'));
            editing.keepMediaIds.push.apply(editing.keepMediaIds, uploaded.map(function(item) { return item.id; }));
            release(editing.pending); editing.pending = [];
            var saved = await request('posts/' + editing.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: editing.editor.content(), contentFormat: editing.editor.format(), visibility: visibility, location: await editing.location.value({ wait: false }), tags: tags,
                    keepMediaIds: editing.keepMediaIds }) });
            release(editing.pending); editing.editor.destroy(); state.editing = null;
            await load(true);
            window.portalToast?.success(saved.cleanupPending ? '保存成功，移除的媒体将在后台清理' : '保存成功');
        } catch (error) {
            if (error.uploaded?.length) {
                release(state.editing.pending); state.editing?.editor.destroy(); state.editing = null; await load(true);
                window.portalToast?.error('部分媒体已上传，请重新编辑文章：' + error.message);
            } else window.portalToast?.error(error.message);
        }
        finally { unlock(); state.saving = false; }
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
    // Remove expired cards even when refreshing fails; authors retain access.
    setInterval(function() {
        var now = Date.now(), expired = false;
        state.posts.forEach(function(post, id) {
            if ((state.isGuest || post.authorId !== state.userId) && post.visibility?.endsAt && Date.parse(post.visibility.endsAt) <= now) {
                feed.querySelector('[data-id="' + id + '"]')?.remove(); state.posts.delete(id); expired = true;
            }
        });
        if (expired) {
            document.querySelector('dialog[aria-label="媒体预览"]')?.close();
            load(true);
        }
    }, 1000);
    setInterval(function() { if (!document.hidden && !state.editing && !feed.querySelector('.blog-comments-content:not([hidden])') && section.classList.contains('hidden') === false) load(true); }, 60000);
    document.addEventListener('visibilitychange', function() { if (!document.hidden && !state.editing && !state.saving && !feed.querySelector('.blog-comments-content:not([hidden])') && !section.classList.contains('hidden')) load(true); });
    initialize();
})();
