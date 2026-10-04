(function() {
    var dialog = document.createElement('dialog');
    dialog.className = 'blog-lightbox blog-media-viewer'; dialog.setAttribute('aria-label', '媒体预览');
    var controls = document.createElement('div'); controls.className = 'blog-lightbox-controls';
    var status = document.createElement('span'); status.setAttribute('role', 'status');
    var stage = document.createElement('div'); stage.className = 'blog-viewer-stage';
    var details = document.createElement('aside'); details.className = 'blog-viewer-details'; details.setAttribute('aria-label', '动态详情');
    var items = [], index = 0, owner, touch, previousOverflow;
    var icons = {
        '上一项': 'M15 18l-6-6 6-6', '下一项': 'M9 18l6-6-6-6', '关闭预览': 'M6 6l12 12M18 6L6 18',
        '放大 / 适应': 'M21 21l-5-5M11 8v6M8 11h6M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
        '移除此媒体': 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
        '动态详情与评论': 'M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4'
    };
    function button(label, action) {
        var control = document.createElement('button'); control.type = 'button'; control.setAttribute('aria-label', label); control.title = label;
        control.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + icons[label] + '"></path></svg>';
        control.addEventListener('click', action); controls.appendChild(control); return control;
    }
    var previous = button('上一项', function() { show(index - 1); });
    previous.className = 'blog-viewer-previous';
    controls.appendChild(status);
    var next = button('下一项', function() { show(index + 1); });
    next.className = 'blog-viewer-next';
    var zoom = button('放大 / 适应', function() { stage.querySelector('img')?.classList.toggle('zoomed'); });
    zoom.className = 'blog-viewer-zoom';
    var remove = button('移除此媒体', function() {
        var action = items[index].removeAction;
        if (!action || !owner) return;
        var trigger = document.createElement('button'); trigger.type = 'button'; trigger.hidden = true;
        Object.keys(action).forEach(function(key) { trigger.dataset[key] = action[key]; });
        owner.appendChild(trigger); trigger.click(); trigger.remove(); dialog.close();
    });
    remove.className = 'blog-viewer-remove';
    var detailToggle = button('动态详情与评论', function() {
        var opened = dialog.classList.toggle('details-open'); detailToggle.setAttribute('aria-expanded', String(opened));
    }); detailToggle.className = 'blog-viewer-detail-toggle'; detailToggle.setAttribute('aria-expanded', 'false');
    var close = button('关闭预览', function() { dialog.close(); }); close.className = 'blog-viewer-close';
    dialog.append(controls, stage, details); document.body.appendChild(dialog);
    function stopVideo() { stage.querySelectorAll('video').forEach(function(video) { video.pause(); video.removeAttribute('src'); video.load(); }); }
    function show(position) {
        if (!items.length) return;
        stopVideo(); stage.replaceChildren(); stage.scrollTo(0, 0);
        index = Math.max(0, Math.min(position, items.length - 1));
        var item = items[index];
        stage.style.backgroundImage = item.kind !== 'video' && item.thumbnailUrl ? 'url(' + JSON.stringify(item.thumbnailUrl) + ')' : '';
        status.textContent = (index + 1) + ' / ' + items.length + ' · 正在加载…';
        previous.disabled = index === 0; next.disabled = index === items.length - 1;
        previous.hidden = next.hidden = items.length < 2;
        zoom.hidden = item.kind === 'video'; remove.hidden = !item.removeAction;
        var media = document.createElement(item.kind === 'video' ? 'video' : 'img');
        var loaded = function() { stage.style.backgroundImage = ''; status.textContent = (index + 1) + ' / ' + items.length; };
        if (item.kind === 'video') {
            media.controls = true; media.playsInline = true; media.preload = 'metadata';
            if (item.thumbnailUrl) media.poster = item.thumbnailUrl;
            media.addEventListener('loadedmetadata', loaded);
        } else { media.alt = '预览图片'; media.addEventListener('load', loaded); media.addEventListener('dblclick', function() { media.classList.toggle('zoomed'); }); }
        media.addEventListener('error', function() { status.textContent = (index + 1) + ' / ' + items.length + ' · 加载失败，可切换或关闭'; });
        media.src = item.url; stage.appendChild(media);
    }
    window.openBlogGallery = function(list, position, root) {
        if (!list.length) return;
        items = list.slice(); owner = root; details.replaceChildren();
        var post = root?.closest('.blog-post');
        if (post) {
            ['.blog-post-meta', '.blog-post-content', '.blog-post-tags'].forEach(function(selector) {
                var source = post.querySelector(selector); if (!source) return;
                var copy = source.cloneNode(true);
                copy.querySelectorAll('button').forEach(function(control) { var text = document.createElement('span'); text.textContent = control.textContent; control.replaceWith(text); });
                details.appendChild(copy);
            });
            if (post.querySelector('[data-action="comments"]') && window.renderBlogDetailComments) {
                var heading = document.createElement('h3'); heading.textContent = '评论';
                var commentPanel = document.createElement('div'); commentPanel.className = 'blog-viewer-comments';
                details.append(heading, commentPanel); window.renderBlogDetailComments(post, commentPanel);
            }
        }
        details.hidden = !details.childElementCount;
        detailToggle.hidden = details.hidden;
        document.querySelectorAll('.blog-media-strip video').forEach(function(video) { video.pause(); });
        if (!dialog.open) previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        show(position || 0); if (!dialog.open) dialog.showModal();
    };
    window.renderBlogGallery = function(root, list) {
        root.replaceChildren(); root.blogGalleryItems = list;
        if (root.classList.contains('blog-post-images')) {
            root.classList.add('blog-media-strip');
            root.tabIndex = 0; root.setAttribute('role', 'region'); root.setAttribute('aria-label', '图片和视频，可左右滑动查看');
            list.forEach(function(item, position) {
                var tile = document.createElement(item.kind === 'video' ? 'div' : 'button'); tile.className = 'blog-strip-item';
                var media = document.createElement(item.kind === 'video' ? 'video' : 'img');
                if (item.kind === 'video') {
                    media.controls = true; media.playsInline = true; media.preload = 'none';
                    if (item.thumbnailUrl) media.poster = item.thumbnailUrl;
                    media.setAttribute('aria-label', '视频 ' + (position + 1));
                } else {
                    tile.type = 'button'; tile.setAttribute('aria-label', '预览图片 ' + (position + 1));
                    tile.addEventListener('click', function() { window.openBlogGallery(root.blogGalleryItems, position, root); });
                    media.alt = '博客图片 ' + (position + 1); media.loading = 'lazy'; media.decoding = 'async';
                    if (item.thumbnailUrl) {
                        var thumbnail = document.createElement('img'); thumbnail.src = item.thumbnailUrl;
                        thumbnail.alt = ''; thumbnail.className = 'blog-strip-thumbnail'; thumbnail.loading = 'lazy';
                        tile.appendChild(thumbnail);
                        media.addEventListener('load', function() { this.previousElementSibling?.remove(); });
                    }
                }
                media.src = item.url; tile.appendChild(media); root.appendChild(tile);
            });
            return;
        }
        list.slice(0, 9).forEach(function(item, position) {
            var tile = document.createElement('div'); tile.className = 'blog-image-tile';
            var open = document.createElement('button'); open.type = 'button'; open.className = 'blog-image-open';
            open.setAttribute('aria-label', '预览' + (item.kind === 'video' ? '视频' : '图片') + ' ' + (position + 1));
            open.addEventListener('click', function() { window.openBlogGallery(root.blogGalleryItems, position, root); });
            if (item.thumbnailUrl || item.kind !== 'video') {
                var image = document.createElement('img'); image.src = item.thumbnailUrl || item.url;
                image.alt = item.kind === 'video' ? '视频封面' : '博客图片'; image.loading = 'lazy'; image.decoding = 'async';
                open.appendChild(image);
            }
            if (item.kind === 'video') { var play = document.createElement('span'); play.className = 'blog-video-play'; play.textContent = '▶'; open.appendChild(play); }
            if (position === 8 && list.length > 9) { var count = document.createElement('span'); count.className = 'blog-gallery-more'; count.textContent = '+' + (list.length - 9); open.appendChild(count); }
            tile.appendChild(open);
            if (item.removeAction) {
                var removeButton = document.createElement('button'); removeButton.type = 'button'; removeButton.className = 'blog-image-remove';
                removeButton.textContent = '×'; removeButton.setAttribute('aria-label', '移除媒体');
                Object.keys(item.removeAction).forEach(function(key) { removeButton.dataset[key] = item.removeAction[key]; });
                tile.appendChild(removeButton);
            }
            root.appendChild(tile);
        });
    };
    dialog.addEventListener('keydown', function(event) {
        if (event.target.closest('input, textarea, [contenteditable="true"], video')) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); show(index + (event.key === 'ArrowLeft' ? -1 : 1)); }
    });
    stage.addEventListener('touchstart', function(event) { var point = event.touches[0]; touch = event.touches.length === 1 ? { x: point.clientX, y: point.clientY } : null; }, { passive: true });
    stage.addEventListener('touchend', function(event) {
        if (!touch || stage.querySelector('.zoomed')) return;
        var point = event.changedTouches[0], dx = point.clientX - touch.x, dy = point.clientY - touch.y;
        touch = null;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) show(index + (dx < 0 ? 1 : -1));
    }, { passive: true });
    dialog.addEventListener('click', function(event) { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', function() { stopVideo(); stage.replaceChildren(); stage.style.backgroundImage = ''; details.replaceChildren(); dialog.classList.remove('details-open'); detailToggle.setAttribute('aria-expanded', 'false'); document.body.style.overflow = previousOverflow || ''; items = []; owner = null; });
    document.addEventListener('click', function(event) {
        var target = event.target.closest('.blog-post-content img, .blog-rich-editor img');
        if (!target || target.closest('.blog-media-viewer')) return;
        var root = target.closest('.blog-post-content, .blog-rich-editor');
        var images = Array.from(root.querySelectorAll('img')).map(function(image) { return { kind: 'image', url: image.src }; });
        event.preventDefault(); window.openBlogGallery(images, images.findIndex(function(item) { return item.url === target.src; }), root);
    });
})();
