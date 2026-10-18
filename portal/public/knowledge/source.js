// Keep arbitrary pages in an opaque sandbox; never embed the Portal itself.
export function externalSource(value, origin) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === origin) return null;
    let embed = url.href;
    const video = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)(?:\/|$)/);
    if (['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname) && video) {
      const player = new URL('https://player.bilibili.com/player.html');
      player.searchParams.set(video[1].startsWith('BV') ? 'bvid' : 'aid', video[1].replace(/^av/, ''));
      player.searchParams.set('autoplay', '0');
      const part = url.searchParams.get('p');
      if (/^[1-9]\d*$/.test(part || '')) player.searchParams.set('p', part);
      embed = player.href;
    }
    return { href: url.href, embed };
  } catch { return null; }
}

export function createSourcePlayer({ player, frame, select, link, hint, allowed }) {
  let document = null, source = null, active = false;
  function clear() {
    player.pause(); player.removeAttribute('src'); player.load();
    frame.removeAttribute('src'); player.hidden = true; frame.hidden = true;
  }
  function choose(value) {
    clear();
    if (!document || !allowed()) return;
    select.value = value === 'original' && source ? 'original' : 'archive';
    if (!active) return;
    if (select.value === 'original') {
      // Bilibili's official player needs its own origin for storage and media.
      const trustedPlayer = new URL(source.embed).hostname === 'player.bilibili.com';
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-presentation' + (trustedPlayer ? ' allow-same-origin' : ''));
      frame.src = source.embed; frame.hidden = false;
      hint.textContent = '如原站限制嵌入或需要登录，可打开原网页，或切换到归档视频。';
    } else {
      hint.textContent = document.status === 'uploading' ? '视频上传完成后可播放归档。' : '播放已上传的归档视频，可通过转写时间准确跳转。';
      if (document.status !== 'uploading') { player.src = '/api/knowledge/documents/' + document.id + '/source'; player.hidden = false; }
    }
  }
  select.addEventListener('change', () => choose(select.value));
  return {
    reset(next) {
      active = false;
      document = next;
      source = next && externalSource(next.sourceUrl, location.origin);
      select.options[0].disabled = !source; select.disabled = !allowed();
      select.options[1].textContent = next?.storage?.provider === '115' ? '115 归档视频' : '服务器归档视频';
      link.hidden = !source || !allowed();
      link.removeAttribute('href'); if (source && allowed()) link.href = source.href;
      choose(source ? 'original' : 'archive');
    },
    activate(value) { active = value; choose(select.value); },
    seek(seconds) {
      if (!document || !allowed()) return;
      if (select.value !== 'archive') choose('archive');
      player.currentTime = seconds; player.play().catch(() => {});
    }
  };
}
