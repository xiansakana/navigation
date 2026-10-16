import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

test('image paste intercepts files before the rich editor without duplicating clipboard entries', async () => {
  const dom = new JSDOM('<div id="editor"><div class="blog-rich-editor" contenteditable="true"></div><input></div>', { runScripts: 'outside-only' });
  try {
    const { window } = dom;
    window.eval(fs.readFileSync(new URL('../public/blog-editor.js', import.meta.url), 'utf8'));
    const root = window.document.querySelector('#editor');
    const editable = root.querySelector('.blog-rich-editor');
    const image = new window.File(['png'], 'clipboard.png', { type: 'image/png' });
    const second = new window.File(['jpg'], 'photo.jpg', { type: 'image/jpeg' });
    const calls = []; let nativePastes = 0;
    window.bindBlogImagePaste(root, files => calls.push(files));
    editable.addEventListener('paste', () => nativePastes++);
    function paste(target, clipboardData) {
      const event = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: clipboardData });
      target.dispatchEvent(event); return event;
    }
    const event = paste(editable, { items: [{ kind: 'file', type: image.type, getAsFile: () => image }, { kind: 'file', type: second.type, getAsFile: () => second }], files: [image, second] });
    assert.equal(event.defaultPrevented, true);
    await Promise.resolve(); assert.equal(calls.length, 1); assert.equal(calls[0].length, 2); assert.equal(nativePastes, 0);
    assert.equal(paste(editable, { items: [], files: [image] }).defaultPrevented, true);
    await Promise.resolve(); assert.equal(calls.length, 2);
    assert.equal(paste(editable, { items: [], files: [], getData: () => '**Markdown**' }).defaultPrevented, false);
    assert.equal(nativePastes, 1);
    assert.equal(paste(root.querySelector('input'), { files: [image] }).defaultPrevented, false);
    await Promise.resolve(); assert.equal(calls.length, 2);
  } finally { dom.window.close(); }
});
