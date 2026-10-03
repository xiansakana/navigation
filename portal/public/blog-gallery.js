(function() {
    var dialog = document.createElement('dialog');
    dialog.className = 'blog-lightbox blog-media-viewer'; dialog.setAttribute('aria-label', '媒体预览');
    var controls = document.createElement('div'); controls.className = 'blog-lightbox-controls';
    var status = document.createElement('span'); status.setAttribute('role', 'status');
    var stage = document.createElement('div'); stage.className = 'blog-viewer-stage';
    var items = [], index = 0, owner, touch;
    function button(label, action) {
        var control = document.createElement('button'); control.type = 'button'; control.textContent = label;
        control.addEventListener('click', action); controls.appendChild(control); return control;
    }
    var previous = button('上一项', function() { show(index - 1); });
    controls.appendChild(status);
    var next = button('下一项', function() { show(index + 1); });
    var zoom = button('放大 / 适应', function() { stage.querySelector('img')?.classList.toggle('zoomed'); });
    var remove = button('移除此媒体', function() {
        var action = items[index].removeAction;
        if (!action || !owner) return;
        var trigger = document.createElement('button'); trigger.type = 'button'; trigger.hidden = true;
        Object.keys(action).forEach(function(key) { trigger.dataset[key] = action[key]; });
        owner.appendChild(trigger); trigger.click(); trigger.remove(); dialog.close();
    });
    button('关闭预览', function() { dialog.close(); });
    dialog.append(controls, stage); document.body.appendChild(dialog);
    function stopVideo() { stage.querySelectorAll('video').forEach(function(video) { video.pause(); video.removeAttribute('src'); video.load(); }); }
    function show(position) {
        if (!items.length) return;
        stopVideo(); stage.replaceChildren(); stage.scrollTo(0, 0);
        index = (position + items.length) % items.length;
        var item = items[index];
        status.textContent = (index + 1) + ' / ' + items.length + ' · 正在加载…';
        previous.disabled = next.disabled = items.length < 2;
        zoom.hidden = item.kind === 'video'; remove.hidden = !item.removeAction;
        var media = document.createElement(item.kind === 'video' ? 'video' : 'img');
        var loaded = function() { status.textContent = (index + 1) + ' / ' + items.length; };
        if (item.kind === 'video') {
            media.controls = true; media.playsInline = true; media.preload = 'metadata';
            if (item.thumbnailUrl) media.poster = item.thumbnailUrl;
            media.addEventListener('loadedmetadata', loaded);
        } else { media.alt = '预览图片'; media.addEventListener('load', loaded); }
        media.addEventListener('error', function() { status.textContent = (index + 1) + ' / ' + items.length + ' · 加载失败，可切换或关闭'; });
        media.src = item.url; stage.appendChild(media);
    }
    window.openBlogGallery = function(list, position, root) {
        items = list.slice(); owner = root; show(position || 0); dialog.showModal();
    };
    window.renderBlogGallery = function(root, list) {
        root.replaceChildren(); root.blogGalleryItems = list;
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
    dialog.addEventListener('close', function() { stopVideo(); stage.replaceChildren(); items = []; owner = null; });
    document.addEventListener('click', function(event) {
        var target = event.target.closest('.blog-post-content img, .blog-rich-editor img');
        if (!target) return;
        var root = target.closest('.blog-post-content, .blog-rich-editor');
        var images = Array.from(root.querySelectorAll('img')).map(function(image) { return { kind: 'image', url: image.src }; });
        event.preventDefault(); window.openBlogGallery(images, images.findIndex(function(item) { return item.url === target.src; }), root);
    });
})();
