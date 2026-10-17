import { getDatabase, loadRbacBlob } from '../../shared/db/index.js';
import { hasPermission, resolveUserPermissions } from '../../portal/src/rbac.js';
import { createCodexStore } from './codex-store.js';
import { executeCodex, projectConfig } from './codex-runner.js';

export function codexEvent(event) {
  if (!event || event.post_type !== 'message' || !['private', 'group'].includes(event.message_type) || String(event.user_id) === String(event.self_id) || !Array.isArray(event.message)) return null;
  const group = event.message_type === 'group';
  if (group && (!/^\d{5,20}$/.test(String(event.group_id || '')) || !event.message.some(s => s.type === 'at' && String(s.data?.qq) === String(event.self_id)))) return null;
  if (event.message.some(s => !['text', 'reply', ...(group ? ['at'] : [])].includes(s.type))) return null;
  const text = event.message.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').trim();
  const match = /^(?:\/codex|codex)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match || !/^\d{5,20}$/.test(String(event.user_id)) || !/^-?\d{1,30}$/.test(String(event.message_id))) return null;
  return { qqId: String(event.user_id), groupId: group ? String(event.group_id) : '', text: (match[1] || '').trim(), key: group ? [event.self_id, 'group', event.group_id, event.user_id, event.message_id].join(':') : [event.self_id, event.user_id, event.message_id].join(':') };
}
export function authorizedCodexUser(config, qq, db) {
  const user = config.allowedUsers?.find(u => String(u.qqId) === String(qq));
  if (!user?.userId) return null;
  const rbac = loadRbacBlob(db), account = rbac?.users?.find(u => u.id === user.userId);
  if (!account || account.enabled === false || account.username === 'guest' || !hasPermission(resolveUserPermissions(rbac, account), 'qq-codex:execute')) return null;
  return user;
}
const help = 'QQ Codex（私聊 / 授权群中@机器人）\ncodex 项目：列出可用项目\ncodex navigation 你的任务：执行任务\ncodex 你的任务：使用默认项目\ncodex 状态：查看当前及最近结果\ncodex 结果：重新读取最近完整结果\ncodex 停止：停止自己的任务\ncodex 同步 [项目]：从Git同步代码和AGENTS.md\ncodex 新会话 [项目]：开始独立的新会话\n群号和结果发送方式可在通知管理的QQ Codex区域配置。群聊会话与私聊隔离。代码通过Git同步，会话仅在QQ端保留。任务结果返回Git提交；电脑 git pull --ff-only 即可取回代码。';

export function createCodexService({ getConfig, send, store: injectedStore, authorize, execute = executeCodex, log = console }) {
  let store = injectedStore, timer, controller, busy = false, delivering = false, stopped = true;
  const settings = () => getConfig().codex || {};
  const storage = () => store ||= createCodexStore(getDatabase());
  const userFor = qq => authorize ? authorize(qq) : authorizedCodexUser(settings(), qq, getDatabase());
  async function receive(raw) {
    const event = codexEvent(raw), config = settings();
    if (!event || !config.enabled || !getConfig().channels?.qq?.enabled) return false;
    const user = userFor(event.qqId);
    if (!user) return true;
    const s = storage(), group = event.groupId;
    if (group && !s.settings(user.userId).groups.includes(group)) return true;
    return s.transaction(() => {
      if (!s.event(event.key)) return true;
      const reply = message => s.reply(user.userId, event.qqId, message, group);
      try {
        const text = event.text, names = (user.projects || []).filter(name => config.projects?.[name]);
        if (!text || ['帮助', 'help'].includes(text)) reply(help);
        else if (text === '项目') reply('可用项目：' + names.join('、') + '\n默认项目：' + (config.defaultProject || names[0] || '未配置'));
        else if (text === '状态') {
          const rows = s.active(user.userId, group);
          reply(rows.length ? rows.map(r => `${r.id.slice(0, 8)} · ${r.project} · ${{ queued: '排队', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已停止' }[r.state]}${r.commit_sha ? ' · ' + r.commit_sha.slice(0, 12) : ''}`).join('\n') : '暂无任务');
        } else if (text === '结果') {
          const result = s.latestResult(user.userId, group) || '暂无任务结果';
          if (group && s.settings(user.userId).groupReply !== 'group') { s.reply(user.userId, event.qqId, result); reply('本群会话的最近结果已安排私聊发送。'); }
          else s.reply(user.userId, event.qqId, result, group, true);
        }
        else if (text === '停止') reply(s.cancel(user.userId, group) ? '已请求停止；正在执行的子进程将终止，已有代码修改保留。' : '没有正在执行或排队的任务');
        else {
          let project = config.defaultProject || names[0], prompt = text;
          const tokens = text.split(/\s+/), first = tokens.shift();
          if (['新会话', '同步'].includes(first)) {
            project = tokens[0] || project;
            if (!names.includes(project)) throw new Error('项目不存在或未授权');
            if (first === '新会话') {
              if (s.active(user.userId, group).some(j => ['queued', 'running'].includes(j.state))) throw new Error('请先等待或停止当前任务');
              s.reset(user.userId, project, group); reply('已开始新会话：' + project); return true;
            }
            prompt = '__sync__';
          } else if (config.projects?.[first]) { project = first; prompt = text.slice(first.length).trim(); }
          if (!names.includes(project)) throw new Error('项目不存在或未授权');
          projectConfig(config, project);
          if (!prompt || prompt.length > 20000) throw new Error('请输入1—20000字的任务');
          const id = s.enqueue(user.userId, event.qqId, event.key, project, prompt, group);
          reply('已接收 Codex ' + id.slice(0, 8) + ' · ' + project + '\n任务在后台执行，可发送 codex 状态 或 codex 停止。');
        }
      } catch (e) { reply(e.message); }
      return true;
    });
  }
  async function deliver() {
    if (delivering || !settings().enabled || !getConfig().channels?.qq?.enabled) return;
    delivering = true;
    try {
      const s = storage(), row = s.pendingReply();
      if (!row) return;
      const user = userFor(row.qq_id);
      if (!user || user.userId !== row.user_id || row.group_id && !s.settings(row.user_id).groups.includes(row.group_id)) { s.delivered(row.id); return; }
      const toGroup = row.group_id && !(row.full_result && s.settings(row.user_id).groupReply !== 'group');
      try { await send(getConfig(), toGroup ? { type: 'group', groupId: row.group_id, atUserId: row.qq_id } : { type: 'private', userId: row.qq_id }, row.message); s.delivered(row.id); }
      catch { s.retryReply(row.id); log.error('[codex] QQ回执暂未送达，已保留重试'); }
    } finally { delivering = false; }
  }
  async function tick() {
    if (busy || stopped || !settings().enabled || !getConfig().channels?.qq?.enabled) return;
    busy = true;
    let job, session = '', heartbeat;
    try {
      const s = storage(); job = s.claim(); if (!job) return;
      const user = userFor(job.qq_id);
      if (!user || user.userId !== job.user_id || !user.projects?.includes(job.project) || job.group_id && !s.settings(job.user_id).groups.includes(job.group_id)) throw new Error('账号或项目授权已撤销');
      controller = new AbortController();
      heartbeat = setInterval(() => {
        try {
          const u = userFor(job.qq_id);
          if (!s.touch(job.id) || s.cancelled(job.id) || !settings().enabled || !getConfig().channels?.qq?.enabled || !u || u.userId !== job.user_id || !u.projects?.includes(job.project) || job.group_id && !s.settings(job.user_id).groups.includes(job.group_id)) controller?.abort();
        } catch { controller?.abort(); }
      }, 1000);
      const result = await execute(settings(), job, s.session(job.user_id, job.project, job.group_id || ''), { signal: controller.signal, onSession: value => { session = value; s.captureSession(job, value); } });
      s.finish(job, { state: 'succeeded', ...result });
    } catch (e) {
      if (job) storage().finish(job, { state: controller?.signal.aborted ? 'cancelled' : 'failed', result: e.message, sessionId: e.sessionId || session });
      else log.error('[codex] 队列读取失败');
    } finally { clearInterval(heartbeat); controller = null; busy = false; }
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    timer = setInterval(() => { void tick(); void deliver().catch(() => {}); }, 1000); timer.unref();
  }
  function stop() { stopped = true; clearInterval(timer); controller?.abort(); }
  return { receive, start, stop, tick, deliver, status: () => ({ enabled: !!settings().enabled, running: busy }) };
}
