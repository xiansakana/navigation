import crypto from 'node:crypto';
import fs from 'node:fs';
import { createBookkeepingStore } from './bookkeeping-store.js';
import { hasPermission } from './rbac.js';
import { billLocationText } from '../../shared/bookkeeping-location.js';

const help = '私聊：记账 支出 35 餐饮 微信 备注=午餐\n收入：记账 收入 5000 工资 支付宝\n转账：转账 500 微信 到 支付宝\n外币：记账 支出 120 HKD 购物 港币账户 日期=2026-10-10\n跨币种转账追加 到账=实际到账金额\n撤销：撤销 账单编号\n位置：私聊先发位置卡片再记账，或记账后补发；每笔忘记位置会提醒。\n群聊可先 @机器人 记账定位，再分享卡片；或记账后直接补发卡片。\n跳过：跳过定位；本笔直接跳过可加 定位=跳过。\n过期补充：补充位置 完整账单编号，然后分享卡片。\n群聊请 @机器人，先在网页 QQ记账 中允许该群。';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const qqNumber = value => /^\d{5,20}$/.test(String(value || ''));
const today = now => new Date(now + 8 * 3600000).toISOString().slice(0, 19);

export function parseQqCommand(text, { accounts, categories, settings, now = Date.now() }) {
  const tokens = text.trim().split(/\s+/), first = tokens.shift();
  const fields = {};
  const positional = tokens.filter(token => {
    const m = /^(日期|备注|币种|到账|手续费|账户|分类|定位)=(.+)$/.exec(token);
    if (!m) return true;
    if (fields[m[1]]) throw new Error('参数重复：' + m[1]);
    fields[m[1]] = m[2]; return false;
  });
  let type = first === '转账' ? '转账' : '支出';
  if(fields.定位 && fields.定位!=='跳过')throw new Error('定位参数只支持 定位=跳过；附带位置请分享位置卡片。');
  if (['支出', '收入', '退款入账', '报销入账', '已报销', '还款', '借出', '收回', '转账'].includes(positional[0])) type = positional.shift();
  const amount = positional.shift();
  if (!/^\d+(\.\d{1,2})?$/.test(amount || '') || Number(amount) <= 0) throw new Error('请输入正数金额，最多两位小数。例：记账 支出 35 餐饮 微信');
  let currency = fields.币种;
  if (/^(CNY|USD|HKD|JPY|MYR|EUR|GBP|SGD)$/.test(positional[0] || '')) currency = positional.shift();
  const findAccount = value => {
    const name = settings.aliases?.[value] || value;
    const matches = accounts.filter(a => !a.archived && (a.name === name || a.id === name));
    if (matches.length !== 1) throw new Error('账户未匹配，请使用网页中的完整账户名或配置别名。');
    return matches[0];
  };
  const transfer = ['转账', '还款', '借出', '收回'].includes(type);
  let category, subcategory = '', account, toAccount;
  if (transfer) {
    account = findAccount(positional.shift() || fields.账户 || settings.defaultAccountId);
    if (positional.shift() !== '到') throw new Error('转账格式：转账 500 微信 到 支付宝');
    toAccount = findAccount(positional.shift()); category = type;
  } else {
    const requested = fields.分类 || positional.shift();
    const kind = type === '收入' ? 'income' : 'expense';
    const name = categories.some(c=>c.kind===kind && !c.archived && c.name===requested) ? requested : (({ 午餐:'餐饮', 早餐:'餐饮', 晚餐:'餐饮', 打车:'交通' })[requested] || requested);
    const matches = categories.filter(c => !c.archived && c.kind === kind && (c.name === name || (c.parentId && categories.find(p=>p.id===c.parentId)?.name + '/' + c.name === name)));
    if (matches.length !== 1) throw new Error('分类未匹配或重名，请使用分类名或“一级分类/二级分类”。');
    const c = matches[0]; category = c.parentId ? categories.find(p=>p.id===c.parentId).name : c.name; subcategory = c.parentId ? c.name : '';
    account = findAccount(fields.账户 || positional.shift() || settings.defaultAccountId);
  }
  if (positional.length) throw new Error('无法识别多余内容；备注请使用 备注=内容，空格可用下划线。');
  let date = today(now);
  if (fields.日期) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.日期)) throw new Error('日期格式：YYYY-MM-DD');
    date = fields.日期 + 'T12:00:00';
  }
  return { type, amount:Number(amount), currency:currency || account.currency, date, category, subcategory,
    accountId:account.id, toAccountId:toAccount?.id, toAmount:fields.到账, fee:fields.手续费, note:(fields.备注 || '').replaceAll('_',' '), skipLocation:fields.定位==='跳过' };
}

export function createQqBookkeeping(db, { resolveUser, clock = Date.now } = {}) {
  const store = createBookkeepingStore(db);
  db.exec(`CREATE TABLE IF NOT EXISTS bookkeeping_qq_bindings(user_id TEXT PRIMARY KEY,qq_id TEXT UNIQUE,settings TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS bookkeeping_qq_codes(user_id TEXT PRIMARY KEY,code_hash TEXT UNIQUE,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bookkeeping_qq_events(event_key TEXT PRIMARY KEY,user_id TEXT NOT NULL,qq_id TEXT NOT NULL,entry_id TEXT,result TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bookkeeping_qq_locations(scope TEXT PRIMARY KEY,user_id TEXT NOT NULL,location TEXT,pending_entry TEXT,expires INTEGER NOT NULL);`);
  const permission = (uid, name = 'entries:edit') => {
    const user = resolveUser?.(uid);
    if (!user || user.isGuest || !hasPermission(user.permissions, 'bookkeeping:view') || !hasPermission(user.permissions,'bookkeeping:accounts:view') || !hasPermission(user.permissions,'bookkeeping:' + name) || !hasPermission(user.permissions,'bookkeeping:qq:edit')) throw new Error('账号已停用或没有 QQ 记账权限。');
    return user;
  };
  function status(uid) {
    const b = db.prepare('SELECT * FROM bookkeeping_qq_bindings WHERE user_id=?').get(uid);
    return { qqId:b?.qq_id || '', settings:b ? JSON.parse(b.settings) : { groups:[], aliases:{} } };
  }
  function code(uid) {
    permission(uid);
    const value = crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO bookkeeping_qq_codes VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,expires=excluded.expires').run(uid,hash(value),clock()+600000);
    return { code:value, expiresIn:600 };
  }
  function save(uid, input) {
    permission(uid);
    const groups = [...new Set(String(input.groups || '').split(/[\s,，]+/).filter(Boolean))];
    if (groups.length > 20 || groups.some(g=>!qqNumber(g))) throw new Error('允许群号最多20个，请用空格或逗号分隔。');
    const accounts = store.accounts(uid).filter(a=>!a.archived);
    if (input.defaultAccountId && !accounts.some(a=>a.id===input.defaultAccountId)) throw new Error('默认账户不可用。');
    const aliases = {};
    for (const line of String(input.aliases || '').split(/\r?\n/).filter(s=>s.trim())) {
      const pair = line.split('=');
      if (pair.length !== 2 || !/^\S{1,40}$/.test(pair[0].trim())) throw new Error('别名格式：微信=资金账户-微信，每行一个。');
      const a = accounts.find(a=>a.name===pair[1].trim()); if(!a) throw new Error('别名对应的账户不存在。');
      const alias=pair[0].trim();if(aliases[alias] || accounts.some(x=>x.name===alias && x.id!==a.id))throw new Error('账户别名重复或与其他账户名称冲突。');aliases[alias]=a.name;
    }
    if(Object.keys(aliases).length>50)throw new Error('账户别名最多50个。');
    const settings={groups,aliases,defaultAccountId:input.defaultAccountId || ''};
    db.prepare("INSERT INTO bookkeeping_qq_bindings(user_id,settings) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings=excluded.settings").run(uid,JSON.stringify(settings));
    return status(uid);
  }
  function unbind(uid) {
    db.transaction(()=>{db.prepare('DELETE FROM bookkeeping_qq_bindings WHERE user_id=?').run(uid);db.prepare('DELETE FROM bookkeeping_qq_codes WHERE user_id=?').run(uid);db.prepare('DELETE FROM bookkeeping_qq_locations WHERE user_id=?').run(uid);})();
  }
  function process(event) {
    if(!qqNumber(event.qqId)||!qqNumber(event.selfId)||!['private','group'].includes(event.type)||!/^[-\w]{1,100}$/.test(String(event.messageId)) || (event.type==='group'&&!qqNumber(event.groupId))) throw new Error('消息身份无效。');
    const text=String(event.text || '').trim(); if(text.length>2000) throw new Error('指令过长。');
    const key=[event.selfId,event.type,event.groupId || event.qqId,event.qqId,event.messageId].join(':');
    return db.transaction(()=>{
      const old=db.prepare('SELECT * FROM bookkeeping_qq_events WHERE event_key=?').get(key);
      if(old) { permission(old.user_id); const current=status(old.user_id); if(current.qqId!==event.qqId)throw new Error('请重新绑定账号。'); if(event.type==='group' && !(current.settings.groups || []).includes(event.groupId))throw new Error('此群未授权。'); return {...JSON.parse(old.result), duplicate:true, sent:!!old.sent, eventKey:key}; }
      let binding=db.prepare('SELECT * FROM bookkeeping_qq_bindings WHERE qq_id=?').get(event.qqId);
      if(event.type==='group' && event.locationOnly && (!binding || !(JSON.parse(binding.settings).groups || []).includes(event.groupId)))return {ignored:true,sent:true};
      if(/^绑定记账\s+/.test(text)) {
        if(event.type!=='private')throw new Error('请私聊机器人发送绑定码。');
        const pending=db.prepare('SELECT * FROM bookkeeping_qq_codes WHERE code_hash=? AND expires>?').get(hash(text.split(/\s+/)[1] || ''),clock());
        if(!pending)throw new Error('绑定码无效或已过期，请在记账网页重新生成。');
        permission(pending.user_id);
        if(binding && binding.user_id!==pending.user_id)throw new Error('此 QQ 已绑定其他账号，请先解绑。');
        db.prepare("INSERT INTO bookkeeping_qq_bindings(user_id,qq_id) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET qq_id=excluded.qq_id").run(pending.user_id,event.qqId);
        db.prepare('DELETE FROM bookkeeping_qq_codes WHERE user_id=?').run(pending.user_id);
        db.prepare('DELETE FROM bookkeeping_qq_locations WHERE user_id=?').run(pending.user_id);
        binding=db.prepare('SELECT * FROM bookkeeping_qq_bindings WHERE user_id=?').get(pending.user_id);
        return remember(binding.user_id,'绑定成功。发送“记账帮助”查看指令。');
      }
      if(!binding)throw new Error('尚未绑定，请登录记账网页，打开“QQ记账”生成绑定码。');
      const uid=binding.user_id, settings=JSON.parse(binding.settings);permission(uid);
      if(event.type==='group' && !(settings.groups || []).includes(event.groupId))throw new Error('此群未授权，请在网页 QQ记账 中添加群号。');
      const scope=[event.selfId,event.type,event.groupId || event.qqId,event.qqId].join(':');
      db.prepare('DELETE FROM bookkeeping_qq_locations WHERE expires<=?').run(clock());
      let context=db.prepare('SELECT * FROM bookkeeping_qq_locations WHERE scope=? AND user_id=?').get(scope,uid);
      const clearLocation=()=>db.prepare('DELETE FROM bookkeeping_qq_locations WHERE scope=?').run(scope);
      const setLocation=(location,pending)=>db.prepare('INSERT INTO bookkeeping_qq_locations VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET user_id=excluded.user_id,location=excluded.location,pending_entry=excluded.pending_entry,expires=excluded.expires').run(scope,uid,location,pending,clock()+600000);
      if(text==='跳过定位') {clearLocation();return remember(uid,'已跳过本次定位，已有账单保留，后续账单仍会提醒补充位置。');}
      if(text==='记账定位') {
        if(context?.pending_entry)throw new Error('上一笔已记账但还没有位置，请先发位置卡片或发送“跳过定位”。');
        setLocation(null,null);return remember(uid,'请在10分钟内分享位置卡片，然后发送记账指令；位置只用于一笔账单。');
      }
      if(/^补充位置\s+/.test(text)) {
        const eid=text.split(/\s+/)[1],prefix=scope+':';
        const own=db.prepare("SELECT 1 FROM bookkeeping_qq_events WHERE user_id=? AND qq_id=? AND entry_id=? AND substr(event_key,1,?)=?").get(uid,event.qqId,eid,prefix.length,prefix);
        if(!own || !db.prepare('SELECT 1 FROM bookkeeping_entries WHERE user_id=? AND id=?').get(uid,eid))throw new Error('只能补充自己在本聊天通过 QQ 创建的账单。');
        setLocation(null,eid);return remember(uid,'请在10分钟内分享位置卡片，为指定账单补充位置。');
      }
      if(event.location) {
        if(event.type==='group' && event.locationOnly && !context)return {ignored:true,sent:true};
        const location=billLocationText(event.location);
        if(event.replyMessageId) {
          const target=db.prepare('SELECT entry_id FROM bookkeeping_qq_events WHERE event_key=? AND user_id=?').get(scope+':'+event.replyMessageId,uid);
          if(!target?.entry_id)throw new Error('引用的消息不是本人在此聊天创建的账单，请用“补充位置 编号”。');
          context={...context,pending_entry:target.entry_id};
        }
        if(context?.pending_entry) {
          const entry=db.prepare('SELECT location FROM bookkeeping_entries WHERE user_id=? AND id=?').get(uid,context.pending_entry);
          if(!entry)throw new Error('待补充账单已删除，请重新记账。');
          // Update only location: never re-save or recalculate financial fields.
          db.prepare('UPDATE bookkeeping_entries SET location=? WHERE user_id=? AND id=?').run(location,uid,context.pending_entry);
          if(!context || context.pending_entry===db.prepare('SELECT pending_entry FROM bookkeeping_qq_locations WHERE scope=?').get(scope)?.pending_entry)clearLocation();
          return remember(uid,'已补充账单位置，金额和账户余额未改变。');
        }
        setLocation(location,null);return remember(uid,'已收到位置，请在10分钟内发送下一笔记账指令；位置仅使用一次。');
      }
      if(text==='记账帮助')return remember(uid,help);
      if(/^撤销\s+/.test(text)) {
        const eid=text.split(/\s+/)[1];
        const own=db.prepare('SELECT entry_id FROM bookkeeping_qq_events WHERE user_id=? AND qq_id=? AND entry_id=?').get(uid,event.qqId,eid);
        if(!own)throw new Error('只能撤销自己通过 QQ 创建的账单，请填写完整编号。');
        store.removeEntry(uid,eid);if(context?.pending_entry===eid)clearLocation();return remember(uid,'已撤销账单 '+eid+'，账户余额已恢复。');
      }
      if(!/^(记账|转账)\s+/.test(text))throw new Error('不支持的指令，请发送“记账帮助”。');
      if(context?.pending_entry)throw new Error('上一笔已记账但还没有位置，请分享位置卡片或发送“跳过定位”后再记下一笔；本指令未入账。');
      const entry=parseQqCommand(text,{accounts:store.accounts(uid),categories:store.catalog.list(uid),settings,now:clock()});
      if(context?.location && !entry.skipLocation)entry.location=context.location;
      const eid=store.saveEntry(uid,entry);
      clearLocation();
      if(!entry.location && !entry.skipLocation)setLocation(null,eid);
      const reminder=entry.location?'\n已附带位置。':entry.skipLocation?'\n本笔已跳过定位。':'\n本笔已保存，但还没有位置。请在10分钟内分享位置卡片补充，或发送“跳过定位”。过期后可用“补充位置 '+eid+'”。';
      return remember(uid,(event.type==='group'?'已记账，编号 '+eid+'。详细信息请在个人账本查看。':`已记账：${entry.date.slice(0,10)} ${entry.type} ${entry.currency} ${entry.amount.toFixed(2)} · ${entry.category}${entry.subcategory?'/'+entry.subcategory:''}\n编号 ${eid}`)+reminder,eid);
      function remember(uid, reply, eid=null) {
        const result={reply,eventKey:key,sent:false};
        db.prepare('INSERT INTO bookkeeping_qq_events(event_key,user_id,qq_id,entry_id,result,created_at) VALUES(?,?,?,?,?,?)').run(key,uid,event.qqId,eid,JSON.stringify(result),clock());return result;
      }
    })();
  }
  function ack(key) {db.prepare('UPDATE bookkeeping_qq_events SET sent=1 WHERE event_key=?').run(key);}
  return {status,code,save,unbind,process,ack};
}

export function internalQqAuthorized(req) {
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return false;
  try {
    const config=JSON.parse(fs.readFileSync(new URL('../../qq-bot/config.json',import.meta.url),'utf8'));
    const expected=Buffer.from('Bearer '+(config.server?.notifyToken || '')),actual=Buffer.from(req.headers.authorization || '');
    return !!config.server?.notifyToken && actual.length===expected.length && crypto.timingSafeEqual(actual,expected);
  } catch {return false;}
}
