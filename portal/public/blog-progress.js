(function() {
    window.uploadBlogBytes = function(path, bytes, type, progress) {
        return new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest(); xhr.open('POST', '/api/blog/' + path);
            if (path.indexOf('/parts/') >= 0) xhr.open('PUT', '/api/blog/' + path);
            xhr.setRequestHeader('Content-Type', type); xhr.timeout = 3600000;
            xhr.upload.onprogress = function(event) { progress(event.loaded); };
            xhr.onerror = xhr.ontimeout = function() { reject(new Error('媒体上传中断，请检查网络后重试')); };
            xhr.onload = function() {
                var result;
                try { result = JSON.parse(xhr.responseText); } catch { return reject(new Error('上传失败（HTTP ' + xhr.status + '）')); }
                if (xhr.status < 200 || xhr.status >= 300 || !result.ok) return reject(new Error(result.error || '上传失败'));
                progress(bytes.size); resolve(result);
            };
            xhr.send(bytes);
        });
    };
    window.createBlogUploadProgress = function(root, items) {
        root.querySelector('.blog-upload-progress')?.remove();
        var panel = document.createElement('div'); panel.className = 'blog-upload-progress'; panel.setAttribute('aria-label', '媒体上传进度');
        var summary = document.createElement('div'); summary.setAttribute('role', 'status'); panel.appendChild(summary);
        var rows = items.map(function(item) {
            var row = document.createElement('div'); row.className = 'blog-upload-progress-row';
            var label = document.createElement('span'); label.textContent = item.file.name;
            var detail = document.createElement('span'); detail.textContent = '等待上传';
            var bar = document.createElement('progress'); bar.max = 100; bar.value = 0; bar.setAttribute('aria-label', item.file.name + ' 上传进度');
            row.append(label, detail, bar); panel.appendChild(row); return { detail: detail, bar: bar, done: false };
        });
        if (items.length) root.appendChild(panel);
        function update(index, phase, percent) {
            var row = rows[index]; if (!row) return;
            percent = Math.max(0, Math.min(100, Math.round(percent || 0)));
            var names = { waiting: '等待处理', transfer: '传到服务器', imageProcessing: '生成缩略图并上传 B2…', compressing: '压缩 MP4', storing: '上传 B2', done: '已完成', failed: '处理失败，请重试' };
            row.detail.textContent = (names[phase] || phase) + (['waiting', 'failed', 'imageProcessing'].includes(phase) ? '' : ' ' + percent + '%');
            row.bar.value = phase === 'done' ? 100 : phase === 'compressing' ? 60 + percent * .25 : phase === 'storing' ? 85 + percent * .15 : phase === 'waiting' ? 60 : percent * (items[index].kind === 'video' ? .6 : 1);
            if (phase === 'imageProcessing') row.bar.removeAttribute('value');
            row.done = phase === 'done';
            summary.textContent = '媒体处理：已完成 ' + rows.filter(function(item) { return item.done; }).length + ' / ' + rows.length;
        }
        summary.textContent = '准备上传 ' + items.length + ' 个媒体';
        return { update: update, clear: function() { panel.remove(); } };
    };
})();
