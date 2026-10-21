import { bilibiliAccount, qualitySettings } from './knowledge-bilibili-account.js';

export function retryKnowledgeDocument(db, store, uid, id, can, input = {}) {
  return db.transaction(() => {
    if (store.getRow(uid, id)?.status !== 'failed') return false;
    const imported = store.imports.get(uid, id)?.state === 'failed';
    if (imported && (!can('import:edit') || !can('upload:edit'))) throw Object.assign(new Error('重新下载视频需要链接导入和上传权限'), { status: 403 });
    const selected = imported ? qualitySettings(input, bilibiliAccount(db).public(uid)) : null;
    const accepted = store.retry(uid, id, input.backend || store.settings(uid).backend);
    if (accepted && imported) db.prepare('UPDATE knowledge_imports SET settings_json=? WHERE user_id=? AND document_id=?').run(JSON.stringify(selected), uid, id);
    return accepted;
  }).immediate();
}
