(function() {
  window.createBlogEditor = function(editor, post) { return window.createUnifiedBlogEditor(editor, post); };

  window.createBlogTags = function(root, initial, suggestions) {
    var tags = (initial || []).slice();
    var chips = document.createElement('div');
    chips.className = 'blog-tag-chips';
    var field = document.createElement('input');
    field.type = 'text';
    field.placeholder = '输入标签，回车添加';
    field.setAttribute('aria-label', '博客标签');
    field.maxLength = 640;
    var datalist = document.createElement('datalist');
    datalist.id = 'blog-tag-options-' + Math.random().toString(36).slice(2);
    field.setAttribute('list', datalist.id);
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'blog-action';
    add.textContent = '添加标签';
    root.classList.add('blog-tag-editor');
    root.append(chips, field, add, datalist);
    function render() {
      chips.replaceChildren();
      tags.forEach(function(tag) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'blog-tag';
        button.textContent = '#' + tag + ' ×';
        button.setAttribute('aria-label', '移除标签 ' + tag);
        button.addEventListener('click', function() { tags = tags.filter(function(item) { return item !== tag; }); render(); });
        chips.appendChild(button);
      });
    }
    function commit() {
      var added = field.value.split(/[,，]/).map(function(tag) { return tag.trim().replace(/^#+/, '').normalize('NFC'); }).filter(Boolean);
      var next = Array.from(new Set(tags.concat(added)));
      if (next.length > 20 || next.some(function(tag) { return tag.length > 30 || /[\u0000-\u001f\u007f]/.test(tag); })) {
        throw new Error('最多 20 个标签，每个最多 30 字');
      }
      tags = next; field.value = ''; render();
    }
    function tryCommit() { try { commit(); } catch (error) { window.portalToast?.error(error.message); } }
    field.addEventListener('keydown', function(event) {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); tryCommit(); }
    });
    add.addEventListener('click', tryCommit);
    render();
    var result = {
      value: function() { commit(); return tags.slice(); },
      clear: function() { tags = []; field.value = ''; render(); },
      suggestions: function(items) {
        datalist.replaceChildren();
        (items || []).forEach(function(item) { var option = document.createElement('option'); option.value = item.tag; datalist.appendChild(option); });
      }
    };
    result.suggestions(suggestions);
    return result;
  };
})();
