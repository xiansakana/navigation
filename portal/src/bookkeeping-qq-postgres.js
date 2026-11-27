import crypto from 'node:crypto';
import { hasPermission } from './rbac.js';
import { billLocationText } from '../../shared/bookkeeping-location.js';
import { parseQqCommand } from './bookkeeping-qq.js';

const help = '私聊：记账 支出 35 餐饮 微信 备注=午餐\n收入：记账 收入 5000 工资 支付宝\n转账：转账 500 微信 到 支付宝\n外币：记账 支出 120 HKD 购物 港币账户 日期=2026-10-10\n跨币种转账追加 到账=实际到账金额\n撤销：撤销 账单编号\n位置：私聊先发位置卡片再记账，或记账后补发；每笔忘记位置会提醒。\n群聊可先 @机器人 记账定位，再分享卡片；或记账后直接补发卡片。\n跳过：跳过定位；本笔直接跳过可加 定位=跳过。\n过期补充：补充位置 完整账单编号，然后分享卡片。\n群聊请 @机器人，先在网页 QQ记账 中允许该群。';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const qqNumber = value => /^\d{5,20}$/.test(String(value || ''));
const today = now => new Date(now + 8 * 3600000).toISOString().slice(0, 19);

export function createPostgresQqBookkeeping(db, store, { resolveUser, clock = Date.now } = {}) {
  const permission = (uid, name = 'entries:edit') => {
    const user = resolveUser?.(uid);
    if (!user || user.isGuest || !hasPermission(user.permissions, 'bookkeeping:view')
      || !hasPermission(user.permissions, 'bookkeeping:accounts:view')
      || !hasPermission(user.permissions, 'bookkeeping:' + name)
      || !hasPermission(user.permissions, 'bookkeeping:qq:edit')) throw new Error('账号已停用或没有 QQ 记账权限。');
    return user;
  };
  async function status(uid) {
    const b = (await db.query('SELECT * FROM navigation.bookkeeping_qq_bindings WHERE user_id=$1', [uid])).rows[0];
    return { qqId: b?.qq_id || '', settings: b ? JSON.parse(b.settings) : { groups: [], aliases: {} } };
  }
  async function code(uid) {
    permission(uid);
    const value = crypto.randomBytes(8).toString('hex');
    await db.query(`INSERT INTO navigation.bookkeeping_qq_codes(user_id,code_hash,expires) VALUES($1,$2,$3)
      ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,expires=excluded.expires`, [uid, hash(value), clock() + 600000]);
    return { code: value, expiresIn: 600 };
  }
  async function save(uid, input) {
    permission(uid);
    const groups = [...new Set(String(input.groups || '').split(/[\s,，]+/).filter(Boolean))];
    if (groups.length > 20 || groups.some(g => !qqNumber(g))) throw new Error('允许群号最多20个，请用空格或逗号分隔。');
    const accounts = (await store.accounts(uid)).filter(a => !a.archived);
    if (input.defaultAccountId && !accounts.some(a => a.id === input.defaultAccountId)) throw new Error('默认账户不可用。');
    const aliases = {};
    for (const line of String(input.aliases || '').split(/\r?\n/).filter(s => s.trim())) {
      const pair = line.split('=');
      if (pair.length !== 2 || !/^\S{1,40}$/.test(pair[0].trim())) throw new Error('别名格式：微信=资金账户-微信，每行一个。');
      const a = accounts.find(a => a.name === pair[1].trim()); if (!a) throw new Error('别名对应的账户不存在。');
      const alias = pair[0].trim();
      if (aliases[alias] || accounts.some(x => x.name === alias && x.id !== a.id)) throw new Error('账户别名重复或与其他账户名称冲突。');
      aliases[alias] = a.name;
    }
    if (Object.keys(aliases).length > 50) throw new Error('账户别名最多50个。');
    const settings = { groups, aliases, defaultAccountId: input.defaultAccountId || '' };
    await db.query(`INSERT INTO navigation.bookkeeping_qq_bindings(user_id,settings) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET settings=excluded.settings`, [uid, JSON.stringify(settings)]);
    return status(uid);
  }
  async function unbind(uid) {
    await db.transaction(async client => {
      await client.query('DELETE FROM navigation.bookkeeping_qq_bindings WHERE user_id=$1', [uid]);
      await client.query('DELETE FROM navigation.bookkeeping_qq_codes WHERE user_id=$1', [uid]);
      await client.query('DELETE FROM navigation.bookkeeping_qq_locations WHERE user_id=$1', [uid]);
    });
  }
  async function process(event) {
    if (!qqNumber(event.qqId) || !qqNumber(event.selfId) || !['private', 'group'].includes(event.type)
      || !/^[-\w]{1,100}$/.test(String(event.messageId)) || (event.type === 'group' && !qqNumber(event.groupId))) throw new Error('消息身份无效。');
    const text = String(event.text || '').trim(); if (text.length > 2000) throw new Error('指令过长。');
    const key = [event.selfId, event.type, event.groupId || event.qqId, event.qqId, event.messageId].join(':');
    return db.transaction(async client => {
      const old = (await client.query('SELECT * FROM navigation.bookkeeping_qq_events WHERE event_key=$1', [key])).rows[0];
      if (old) {
        permission(old.user_id);
        const current = await status(old.user_id);
        if (current.qqId !== event.qqId) throw new Error('请重新绑定账号。');
        if (event.type === 'group' && !(current.settings.groups || []).includes(event.groupId)) throw new Error('此群未授权。');
        return { ...JSON.parse(old.result), duplicate: true, sent: !!old.sent, eventKey: key };
      }
      let binding = (await client.query('SELECT * FROM navigation.bookkeeping_qq_bindings WHERE qq_id=$1', [event.qqId])).rows[0];
      if (event.type === 'group' && event.locationOnly && (!binding || !(JSON.parse(binding.settings).groups || []).includes(event.groupId))) {
        return { ignored: true, sent: true };
      }
      if (/^绑定记账\s+/.test(text)) {
        if (event.type !== 'private') throw new Error('请私聊机器人发送绑定码。');
        const pending = (await client.query('SELECT * FROM navigation.bookkeeping_qq_codes WHERE code_hash=$1 AND expires>$2',
          [hash(text.split(/\s+/)[1] || ''), clock()])).rows[0];
        if (!pending) throw new Error('绑定码无效或已过期，请在记账网页重新生成。');
        permission(pending.user_id);
        if (binding && binding.user_id !== pending.user_id) throw new Error('此 QQ 已绑定其他账号，请先解绑。');
        await client.query(`INSERT INTO navigation.bookkeeping_qq_bindings(user_id,qq_id) VALUES($1,$2)
          ON CONFLICT(user_id) DO UPDATE SET qq_id=excluded.qq_id`, [pending.user_id, event.qqId]);
        await client.query('DELETE FROM navigation.bookkeeping_qq_codes WHERE user_id=$1', [pending.user_id]);
        await client.query('DELETE FROM navigation.bookkeeping_qq_locations WHERE user_id=$1', [pending.user_id]);
        binding = (await client.query('SELECT * FROM navigation.bookkeeping_qq_bindings WHERE user_id=$1', [pending.user_id])).rows[0];
        return remember(binding.user_id, '绑定成功。发送“记账帮助”查看指令。');
      }
      if (!binding) throw new Error('尚未绑定，请登录记账网页，打开“QQ记账”生成绑定码。');
      const uid = binding.user_id, settings = JSON.parse(binding.settings); permission(uid);
      if (event.type === 'group' && !(settings.groups || []).includes(event.groupId)) throw new Error('此群未授权，请在网页 QQ记账 中添加群号。');
      const scope = [event.selfId, event.type, event.groupId || event.qqId, event.qqId].join(':');
      await client.query('DELETE FROM navigation.bookkeeping_qq_locations WHERE expires<=$1', [clock()]);
      let context = (await client.query('SELECT * FROM navigation.bookkeeping_qq_locations WHERE scope=$1 AND user_id=$2', [scope, uid])).rows[0];
      const clearLocation = () => client.query('DELETE FROM navigation.bookkeeping_qq_locations WHERE scope=$1', [scope]);
      const setLocation = (location, pending) => client.query(`INSERT INTO navigation.bookkeeping_qq_locations(scope,user_id,location,pending_entry,expires)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(scope) DO UPDATE SET user_id=excluded.user_id,location=excluded.location,
        pending_entry=excluded.pending_entry,expires=excluded.expires`, [scope, uid, location, pending, clock() + 600000]);
      if (text === '跳过定位') { await clearLocation(); return remember(uid, '已跳过本次定位，已有账单保留，后续账单仍会提醒补充位置。'); }
      if (text === '记账定位') {
        if (context?.pending_entry) throw new Error('上一笔已记账但还没有位置，请先发位置卡片或发送“跳过定位”。');
        await setLocation(null, null);
        return remember(uid, '请在10分钟内分享位置卡片，然后发送记账指令；位置只用于一笔账单。');
      }
      if (/^补充位置\s+/.test(text)) {
        const eid = text.split(/\s+/)[1], prefix = scope + ':';
        const own = (await client.query(`SELECT 1 FROM navigation.bookkeeping_qq_events
          WHERE user_id=$1 AND qq_id=$2 AND entry_id=$3 AND substr(event_key,1,$4)=$5`, [uid, event.qqId, eid, prefix.length, prefix])).rows[0];
        const exists = (await client.query('SELECT 1 FROM navigation.bookkeeping_entries WHERE user_id=$1 AND id=$2', [uid, eid])).rows[0];
        if (!own || !exists) throw new Error('只能补充自己在本聊天通过 QQ 创建的账单。');
        await setLocation(null, eid);
        return remember(uid, '请在10分钟内分享位置卡片，为指定账单补充位置。');
      }
      if (event.location) {
        if (event.type === 'group' && event.locationOnly && !context) return { ignored: true, sent: true };
        const location = billLocationText(event.location);
        if (event.replyMessageId) {
          const target = (await client.query('SELECT entry_id FROM navigation.bookkeeping_qq_events WHERE event_key=$1 AND user_id=$2',
            [scope + ':' + event.replyMessageId, uid])).rows[0];
          if (!target?.entry_id) throw new Error('引用的消息不是本人在此聊天创建的账单，请用“补充位置 编号”。');
          context = { ...context, pending_entry: target.entry_id };
        }
        if (context?.pending_entry) {
          const entry = (await client.query('SELECT location FROM navigation.bookkeeping_entries WHERE user_id=$1 AND id=$2', [uid, context.pending_entry])).rows[0];
          if (!entry) throw new Error('待补充账单已删除，请重新记账。');
          await client.query('UPDATE navigation.bookkeeping_entries SET location=$1 WHERE user_id=$2 AND id=$3', [location, uid, context.pending_entry]);
          const pendingRow = (await client.query('SELECT pending_entry FROM navigation.bookkeeping_qq_locations WHERE scope=$1', [scope])).rows[0];
          if (!context || context.pending_entry === pendingRow?.pending_entry) await clearLocation();
          return remember(uid, '已补充账单位置，金额和账户余额未改变。');
        }
        await setLocation(location, null);
        return remember(uid, '已收到位置，请在10分钟内发送下一笔记账指令；位置仅使用一次。');
      }
      if (text === '记账帮助') return remember(uid, help);
      if (/^撤销\s+/.test(text)) {
        const eid = text.split(/\s+/)[1];
        const own = (await client.query('SELECT entry_id FROM navigation.bookkeeping_qq_events WHERE user_id=$1 AND qq_id=$2 AND entry_id=$3',
          [uid, event.qqId, eid])).rows[0];
        if (!own) throw new Error('只能撤销自己通过 QQ 创建的账单，请填写完整编号。');
        await store.removeEntry(uid, eid);
        if (context?.pending_entry === eid) await clearLocation();
        return remember(uid, '已撤销账单 ' + eid + '，账户余额已恢复。');
      }
      if (!/^(记账|转账)\s+/.test(text)) throw new Error('不支持的指令，请发送“记账帮助”。');
      if (context?.pending_entry) throw new Error('上一笔已记账但还没有位置，请分享位置卡片或发送“跳过定位”后再记下一笔；本指令未入账。');
      const entry = parseQqCommand(text, { accounts: await store.accounts(uid), categories: await store.catalog.list(uid), settings, now: clock() });
      if (context?.location && !entry.skipLocation) entry.location = context.location;
      const eid = await store.saveEntry(uid, entry);
      await clearLocation();
      if (!entry.location && !entry.skipLocation) await setLocation(null, eid);
      const reminder = entry.location ? '\n已附带位置。' : entry.skipLocation ? '\n本笔已跳过定位。'
        : '\n本笔已保存，但还没有位置。请在10分钟内分享位置卡片补充，或发送“跳过定位”。过期后可用“补充位置 ' + eid + '”。';
      return remember(uid, (event.type === 'group' ? '已记账，编号 ' + eid + '。详细信息请在个人账本查看。'
        : `已记账：${entry.date.slice(0, 10)} ${entry.type} ${entry.currency} ${entry.amount.toFixed(2)} · ${entry.category}${entry.subcategory ? '/' + entry.subcategory : ''}\n编号 ${eid}`) + reminder, eid);
      async function remember(rememberUid, reply, eid = null) {
        const result = { reply, eventKey: key, sent: false };
        await client.query(`INSERT INTO navigation.bookkeeping_qq_events(event_key,user_id,qq_id,entry_id,result,created_at)
          VALUES($1,$2,$3,$4,$5,$6)`, [key, rememberUid, event.qqId, eid, JSON.stringify(result), clock()]);
        return result;
      }
    });
  }
  async function ack(key) {
    await db.query('UPDATE navigation.bookkeeping_qq_events SET sent=1 WHERE event_key=$1', [key]);
  }
  return { status, code, save, unbind, process, ack };
}
