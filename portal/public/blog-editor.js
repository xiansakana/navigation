(function() {
  window.createBlogEditor = function(editor, post) {
    editor.classList.add('blog-rich-editor');
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    editor.setAttribute('aria-label', '写点什么');
    editor.dataset.placeholder = '分享此刻的想法……';
    if (post?.contentFormat === 'html') editor.innerHTML = post.content;
    else (post?.content || '').split('\n').forEach(function(line, index) {
      if (index) editor.appendChild(document.createElement('br'));
      editor.appendChild(document.createTextNode(line));
    });
    var toolbar = document.createElement('div');
    toolbar.className = 'blog-rich-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', '文字格式');
    [['加粗', 'bold'], ['斜体', 'italic'], ['下划线', 'underline'], ['删除线', 'strikeThrough'],
      ['标题', 'formatBlock', 'h2'], ['正文', 'formatBlock', 'p'], ['无序列表', 'insertUnorderedList'],
      ['有序列表', 'insertOrderedList'], ['引用', 'formatBlock', 'blockquote'], ['链接', 'createLink'],
      ['移除链接', 'unlink'], ['清除格式', 'removeFormat']].forEach(function(spec) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = spec[0];
      button.setAttribute('aria-label', spec[0]);
      // Keep the text selection when a toolbar control is clicked.
      button.addEventListener('mousedown', function(event) { event.preventDefault(); });
      button.addEventListener('click', function() {
        editor.focus();
        var value = spec[2];
        if (spec[1] === 'createLink') {
          value = prompt('输入链接地址（https://、http:// 或 mailto:）');
          if (!value) return;
          value = value.trim();
          if (!/^(https?:\/\/|mailto:)/i.test(value)) { window.portalToast?.error('请输入有效的链接地址'); return; }
        }
        document.execCommand(spec[1], false, value);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
      toolbar.appendChild(button);
    });
    editor.before(toolbar);
    var mode = document.createElement('select');
    mode.setAttribute('aria-label', '编辑格式');
    [['html', '富文本'], ['markdown', 'Markdown']].forEach(function(item) {
      var option = document.createElement('option'); option.value = item[0]; option.textContent = item[1]; mode.appendChild(option);
    });
    toolbar.before(mode);
    var markdown = document.createElement('textarea');
    markdown.className = 'blog-markdown-source'; markdown.maxLength = 10000; markdown.rows = 8;
    markdown.setAttribute('aria-label', 'Markdown 内容');
    markdown.placeholder = '# 标题\n\n支持 **加粗**、列表、链接、代码块和表格';
    var rendered = document.createElement('div');
    rendered.className = 'blog-markdown-preview blog-rich-content';
    rendered.setAttribute('aria-label', 'Markdown 预览');
    rendered.setAttribute('role', 'region');
    editor.after(markdown, rendered);
    function renderMarkdown() {
      rendered.innerHTML = DOMPurify.sanitize(marked.parse(markdown.value, { gfm: true, breaks: true }));
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function updateMode() {
      var isMarkdown = mode.value === 'markdown';
      editor.hidden = isMarkdown; toolbar.hidden = isMarkdown;
      markdown.hidden = !isMarkdown; rendered.hidden = !isMarkdown;
      if (isMarkdown) renderMarkdown();
    }
    mode.addEventListener('change', function() {
      if (mode.value === 'markdown') markdown.value = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(editor.innerHTML);
      else editor.innerHTML = DOMPurify.sanitize(marked.parse(markdown.value, { gfm: true, breaks: true }));
      updateMode();
    });
    markdown.addEventListener('input', renderMarkdown);
    if (post?.contentFormat === 'markdown') { mode.value = 'markdown'; markdown.value = post.content; }
    updateMode();
    editor.addEventListener('paste', function(event) {
      event.preventDefault();
      document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    });
    editor.addEventListener('drop', function(event) { event.preventDefault(); });
    return {
      content: function() { return mode.value === 'markdown' ? markdown.value : editor.innerHTML; },
      format: function() { return mode.value; },
      focus: function() { (mode.value === 'markdown' ? markdown : editor).focus(); },
      length: function() { return mode.value === 'markdown' ? markdown.value.length : editor.textContent.length; },
      isEmpty: function() { return !(mode.value === 'markdown' ? markdown.value : editor.textContent).trim(); },
      clear: function() { editor.replaceChildren(); markdown.value = ''; rendered.replaceChildren(); }
    };
  };

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
