(function() {
  window.createBlogLocation = function(root, initial) {
    var location = initial || null;
    var status = document.createElement('span'); status.setAttribute('role', 'status');
    var clear = document.createElement('button'); clear.type = 'button'; clear.textContent = '移除定位';
    var retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新定位';
    root.className = 'blog-location-editor'; root.append(status, retry, clear);
    var generation = 0, pending = null, started = false;
    function render() { status.textContent = location ? '📍 ' + (location.label || location.latitude.toFixed(5) + ', ' + location.longitude.toFixed(5)) : '未附带位置信息'; }
    function start(force) {
      if (started && !force) return pending;
      started = true;
      if (location && !force) { render(); return Promise.resolve(); }
      var current = ++generation;
      status.textContent = '正在自动获取位置…';
      pending = new Promise(function(resolve) {
        if (!navigator.geolocation) { status.textContent = '浏览器不支持定位'; resolve(); return; }
        navigator.geolocation.getCurrentPosition(function(position) {
          if (current === generation) {
            location = { label: '', latitude: position.coords.latitude, longitude: position.coords.longitude }; render();
          }
          resolve();
        }, function(error) {
          if (current === generation) status.textContent = error.code === 1 ? '未获定位授权，将不附带位置' : '自动定位失败，将不附带位置';
          resolve();
        }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
      });
      return pending;
    }
    retry.addEventListener('click', function() { start(true); });
    clear.addEventListener('click', function() { generation++; location = null; pending = null; render(); });
    render();
    return {
      start: start,
      value: async function() { await pending; return location; },
      clear: function() { generation++; location = null; started = false; pending = null; start(); }
    };
  };

  var dialog = document.createElement('dialog'); dialog.className = 'blog-lightbox'; dialog.setAttribute('aria-label', '图片预览');
  var image = document.createElement('img'); image.alt = '预览图片';
  var status = document.createElement('div'); status.setAttribute('role', 'status');
  var controls = document.createElement('div'); controls.className = 'blog-lightbox-controls';
  var items = [], index = 0;
  function control(label, action) { var button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', action); controls.appendChild(button); return button; }
  var previous = control('上一张', function() { show(index - 1); });
  var next = control('下一张', function() { show(index + 1); });
  control('放大 / 适应', function() { image.classList.toggle('zoomed'); });
  control('关闭预览', function() { dialog.close(); });
  dialog.append(controls, status, image); document.body.appendChild(dialog);
  function show(position) {
    index = (position + items.length) % items.length;
    status.textContent = '正在加载图片… ' + (index + 1) + ' / ' + items.length;
    image.classList.remove('zoomed'); image.src = items[index];
    previous.disabled = next.disabled = items.length < 2;
  }
  image.addEventListener('load', function() { status.textContent = (index + 1) + ' / ' + items.length; });
  image.addEventListener('error', function() { status.textContent = '图片加载失败'; });
  dialog.addEventListener('click', function(event) { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('keydown', function(event) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); show(index - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); show(index + 1); }
  });
  dialog.addEventListener('close', function() { image.removeAttribute('src'); items = []; });
  document.addEventListener('click', function(event) {
    var target = event.target.closest('[data-blog-image], .blog-post-content img, .blog-rich-editor img');
    if (!target) return;
    var source = target.dataset.blogImage || target.getAttribute('src');
    if (!source) return;
    event.preventDefault();
    var group = target.closest('.blog-image-preview, .blog-post-images, .blog-post-content, .blog-rich-editor');
    items = group ? Array.from(group.querySelectorAll('[data-blog-image], img')).filter(function(item) { return item.dataset.blogImage || !item.closest('[data-blog-image]'); }).map(function(item) { return item.dataset.blogImage || item.getAttribute('src'); }).filter(Boolean) : [source];
    index = Math.max(0, items.indexOf(source)); show(index); dialog.showModal();
  });
})();
