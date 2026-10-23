export function parseQqMentions(value) {
  const text = String(value ?? '').trim();
  if (text.length > 4096) throw new Error('@ QQ 号内容过长，最多50个');
  const entries = [...new Set(text.split(/[\s,，;；、]+/u).filter(Boolean).map(item => item.toLowerCase()))];
  if (entries.some(item => !/^(\d{1,20}|all)$/.test(item))) {
    throw new Error('@ 目标应为 QQ 号，多个号码用逗号、分号或空格分隔；all 表示所有人');
  }
  if (entries.includes('all')) return ['all'];
  if (entries.length > 50) throw new Error('每条通知最多 @50个 QQ 号');
  return entries;
}

export function normalizeQqMentions(value) {
  return parseQqMentions(value).join(',');
}
