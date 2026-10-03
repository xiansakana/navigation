(function() {
  var addresses = new Map();
  window.resolveBlogAddress = function(location, force) {
    if (location.label && !force) return Promise.resolve(location.label);
    var key = location.latitude.toFixed(5) + ',' + location.longitude.toFixed(5);
    if (!force && addresses.has(key)) return addresses.get(key);
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 8000);
    var request = fetch('/api/blog/location?latitude=' + encodeURIComponent(location.latitude) + '&longitude=' + encodeURIComponent(location.longitude), { signal: controller.signal })
      .then(function(response) { if (!response.ok) throw new Error('地址暂不可用'); return response.json(); })
      .then(function(data) { return data.ok && typeof data.label === 'string' ? data.label : ''; })
      .catch(function() { return ''; })
      .finally(function() { clearTimeout(timer); });
    addresses.set(key, request);
    if (addresses.size > 100) addresses.delete(addresses.keys().next().value);
    return request;
  };
  window.createBlogLocationSource = function() {
    var link = document.createElement('a');
    link.className = 'blog-location-source'; link.href = 'https://www.openstreetmap.org/copyright';
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '© OpenStreetMap';
    return link;
  };
  window.createBlogLocation = function(root, initial) {
    var location = initial || null;
    var status = document.createElement('span'); status.setAttribute('role', 'status');
    var clear = document.createElement('button'); clear.type = 'button'; clear.textContent = '移除定位';
    var retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新定位';
    root.className = 'blog-location-editor'; root.append(status, retry, clear, window.createBlogLocationSource());
    var generation = 0, pending = null, started = false;
    function render() { status.textContent = location ? '📍 ' + (location.label || '地址暂不可用，可重新定位') : '未附带位置信息'; }
    function address(current, force) {
      var captured = location;
      status.textContent = '正在解析位置地址（不影响保存）…';
      return window.resolveBlogAddress(captured, force).then(function(label) {
        if (current !== generation) return;
        location = Object.assign({}, captured, { label: label }); render();
      });
    }
    function start(force) {
      if (started && !force) return pending;
      started = true;
      if (location && !force) {
        if (location.label) { render(); return Promise.resolve(); }
        pending = address(++generation, false); return pending;
      }
      var current = ++generation;
      status.textContent = '正在自动获取位置（不影响保存）…';
      pending = new Promise(function(resolve) {
        var timer = setTimeout(function() {
          if (current === generation) { generation++; status.textContent = '自动定位超时，将不附带位置'; }
          resolve();
        }, 10000);
        function finish() { clearTimeout(timer); resolve(); }
        if (!navigator.geolocation) { status.textContent = '浏览器不支持定位'; finish(); return; }
        navigator.geolocation.getCurrentPosition(function(position) {
          if (current === generation) {
            clearTimeout(timer);
            location = { label: '', latitude: position.coords.latitude, longitude: position.coords.longitude };
            address(current, force).finally(finish);
            return;
          }
          finish();
        }, function(error) {
          if (current === generation) status.textContent = error.code === 1 ? '未获定位授权，将不附带位置' : '自动定位失败，将不附带位置';
          finish();
        }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
      });
      return pending;
    }
    retry.addEventListener('click', function() { start(true); });
    clear.addEventListener('click', function() { generation++; location = null; pending = null; render(); });
    render();
    return {
      start: start,
      value: async function(options) { if (!options || options.wait !== false) await pending; return location ? Object.assign({}, location) : null; },
      clear: function() { generation++; location = null; started = false; pending = null; start(); }
    };
  };

})();
