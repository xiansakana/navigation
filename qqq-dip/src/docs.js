import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

const DOCS = {
  cheatsheet: {
    title: '抄底手册速查',
    file: 'cheatsheet.md'
  },
  manual: {
    title: '抄底分析报告与操作手册',
    file: 'manual.md'
  }
};

function rewriteLinks(md) {
  return md
    .replace(/\]\(\.\/抄底分析报告与操作手册\.md\)/g, '](doc:manual)')
    .replace(/\]\(\.\/抄底手册速查\.md\)/g, '](doc:cheatsheet)')
    .replace(/\]\(抄底分析报告与操作手册\.md\)/g, '](doc:manual)')
    .replace(/\]\(抄底手册速查\.md\)/g, '](doc:cheatsheet)');
}

export function createDocService(publicDir) {
  const docsDir = path.join(publicDir, 'docs');

  function listDocs() {
    return Object.entries(DOCS).map(([id, meta]) => ({ id, title: meta.title }));
  }

  function getDoc(id) {
    const meta = DOCS[id];
    if (!meta) return null;
    const filePath = path.join(docsDir, meta.file);
    if (!fs.existsSync(filePath)) return null;
    const md = fs.readFileSync(filePath, 'utf8');
    const html = marked.parse(rewriteLinks(md));
    const version = md.match(/版本[：:]\s*(\S+)/)?.[1] || null;
    return { id, title: meta.title, html, version };
  }

  return { listDocs, getDoc };
}
