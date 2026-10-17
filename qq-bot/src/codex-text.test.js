import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { codexQqText, codexQqChunks } from './codex-text.js';
import { createCodexStore } from './codex-store.js';

const Database = createRequire(new URL('../../portal/package.json', import.meta.url))('better-sqlite3');
test('QQ chunks prefer line boundaries and never split an emoji surrogate pair', () => {
  const code = 'x'.repeat(1000) + '\n' + 'y'.repeat(800);
  const lines = codexQqChunks('```\n' + code + '\n```');
  assert.equal(lines[0], 'x'.repeat(1000) + '\n');assert.equal(lines.join(''), code);
  const emoji = codexQqChunks('a'.repeat(1499) + '😀' + 'z'.repeat(100));
  assert.equal(emoji.join(''), 'a'.repeat(1499) + '😀' + 'z'.repeat(100));
  assert.ok(emoji.every(part => part.isWellFormed() && part.length <= 1500));
});
test('QQ text removes Markdown formatting while retaining links, references, lists and tables', () => {
  const source = '# 处理结果\n\n**已经完成**，*说明*与~~旧值~~。\n下一行\n\n> 引用 **内容**\n\n- [x] 已处理\n- [ ] 待处理\n  - 子项\n\n3. 第三项\n4. 第四项\n\n| 项目 | 状态 |\n| --- | --- |\n| `test_case` | **通过** |\n\n[文档][docs]、<https://example.com>、![示意图](https://example.com/a.png)\n\n[docs]: https://example.com/docs';
  const text = codexQqText(source);
  assert.match(text, /^处理结果\n/);assert.match(text, /已经完成，说明与旧值。\n下一行/);
  assert.match(text, /引用：\n  引用 内容/);assert.match(text, /☑ 已处理\n☐ 待处理\n  • 子项/);
  assert.match(text, /3\. 第三项\n4\. 第四项/);assert.match(text, /项目：test_case；状态：通过/);
  assert.match(text, /文档（https:\/\/example.com\/docs）/);assert.match(text, /示意图（https:\/\/example.com\/a.png）/);
  assert.doesNotMatch(text, /\*\*|~~|^#|\[docs\]|\| ---/m);
});

test('QQ text preserves code, literal escapes, paths and plain-text line breaks', () => {
  const code = 'const file_name = "**literal**";\nif (a < b && c > 0) {\n  value *= 2;\n}\n// `ticks` | _underscores_';
  assert.equal(codexQqText('```js\n' + code + '\n```'), code);
  assert.equal(codexQqText('`a_b * c` / `C:\\my_files\\a.js`'), 'a_b * c / C:\\my_files\\a.js');
  assert.equal(codexQqText('普通文字\n下一行\n\n另一段'), '普通文字\n下一行\n\n另一段');
  assert.equal(codexQqText('```\n  indented_code();\n```'), '  indented_code();');
  assert.equal(codexQqText('foo_bar_baz.js，\\*原样星号\\*，&amp; &#60; &#x1f600;'), 'foo_bar_baz.js，*原样星号*，& < 😀');
  assert.equal(codexQqText('[源文件](D:/My%20Files/app.js:12)'), '源文件（D:/My%20Files/app.js:12）');
});

test('QQ automatic replies and replay convert before splitting; raw job history remains Markdown', () => {
  const db = new Database(':memory:'),store=createCodexStore(db);
  try {
    const raw = '# 完成\n\n**结果**：[文档](https://example.com)\n\n```js\n' + 'const file_name = "**literal**";\n'.repeat(80) + '```\n\n`[CQ:at,qq=all]`';
    store.enqueue('u','12345678','md-task','navigation','do it');const job=store.claim();
    store.finish(job,{state:'succeeded',result:raw});
    const replies=db.prepare('SELECT message FROM qq_codex_outbox ORDER BY id').all();assert.ok(replies.length>1);
    const sent=replies.map(row=>row.message).join('');assert.match(sent,/结果：文档（https:\/\/example.com）/);assert.doesNotMatch(sent,/```|# 完成|\*\*结果\*\*|\[CQ:/);
    assert.match(sent,/const file_name = "\*\*literal\*\*";/);assert.match(sent,/［CQ:at,qq=all\]/);
    assert.equal(store.latestResult('u'),raw);
    db.prepare('DELETE FROM qq_codex_outbox').run();store.reply('u','12345678',store.latestResult('u'),'33333333',true);
    const replay=db.prepare('SELECT message,group_id FROM qq_codex_outbox ORDER BY id').all();assert.ok(replay.every(row=>row.group_id==='33333333'));
    assert.equal(replay.map(row=>row.message).join(''),codexQqText(raw).replace(/\[CQ:/gi,'［CQ:'));
  } finally {db.close();}
});
