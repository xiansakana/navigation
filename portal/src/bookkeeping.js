import { createQqBookkeeping } from './bookkeeping-qq.js';
import { parseCoordinates, resolveAddress } from './blog-address.js';
import crypto from 'node:crypto';
import { historicalFx } from './bookkeeping-historical-fx.js';
import { analyzeBookkeeping } from './bookkeeping-analysis.js';
import { accountLedger } from './bookkeeping-ledger.js';
import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from './rbac.js';
import { createBookkeepingStore, summarize } from './bookkeeping-store.js';
import { parseIcost, exportIcost } from './bookkeeping-import.js';
import { effectiveBookkeepingFx, refreshBookkeepingFx } from './bookkeeping-fx.js';

const imports = new Map();
const ttl = 15 * 60 * 1000;
export function canBookkeep(session, feature = 'view') {
  return !!session?.userId && !session.isGuest && hasPermission(session.permissions || [], 'bookkeeping:' + feature);
}
async function body(req, binary = false) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length; if (size > (binary ? 15 : 2) * 1024 * 1024) throw new Error('请求超过大小限制');
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  if (binary) return data;
  try { return JSON.parse(data.toString('utf8')); } catch { throw new Error('请求体不是合法 JSON'); }
}
export async function handleBookkeepingApi(req, res, url, session, json) {
  res.setHeader('Cache-Control', 'no-store');
  if (!canBookkeep(session)) return json(res, 403, { ok: false, error: '请登录并获取记账查看权限' });
  const route = url.pathname.slice('/api/bookkeeping'.length), method = req.method;
  const permission = route === '/preferences' ? 'view' : route === '/location' ? 'location:edit' : route.startsWith('/qq') ? 'qq:edit' : route.startsWith('/categories') ? (method === 'GET' ? 'categories:view' : 'categories:edit') : route.startsWith('/groups') ? (method === 'GET' ? 'accounts:view' : 'accounts:edit') : route === '/fx/refresh' ? 'fx:edit' : route.startsWith('/import') ? 'import:edit' : route === '/export' ? 'export:view' : route.startsWith('/settings') && method !== 'GET' ? 'settings:edit' :
    route.startsWith('/accounts') ? (method === 'GET' ? 'accounts:view' : 'accounts:edit') : method === 'GET' ? 'view' : 'entries:edit';
  if (!canBookkeep(session, permission)) return json(res, 403, { ok: false, error: '无权执行此记账操作' });
  if (!['GET', 'HEAD'].includes(method) && req.headers.origin && req.headers.origin !== new URL(req.url, 'http://' + req.headers.host).origin && req.headers.origin !== 'https://' + req.headers.host) {
    return json(res, 403, { ok: false, error: '不允许跨站写入' });
  }
  const store = createBookkeepingStore(getDatabase()), uid = session.userId;
  try {
    if(route==='/location' && method==='GET') {
      if(!canBookkeep(session,'entries:edit'))return json(res,403,{ok:false,error:'无权获取记账位置'});
      const coordinates=parseCoordinates(url.searchParams);
      return json(res,200,{ok:true,label:await resolveAddress(coordinates)});
    }
    if (route.startsWith('/qq')) {
      const service=createQqBookkeeping(getDatabase(),{resolveUser:id=>id===uid?session:null});
      if(route==='/qq' && method==='GET')return json(res,200,{ok:true,...service.status(uid)});
      if(route==='/qq' && method==='PUT')return json(res,200,{ok:true,...service.save(uid,await body(req))});
      if(route==='/qq/code' && method==='POST')return json(res,200,{ok:true,...service.code(uid)});
      if(route==='/qq' && method==='DELETE'){service.unbind(uid);return json(res,200,{ok:true});}
    }
    if (route === '/preferences' && method === 'GET') return json(res,200,{ok:true,period:store.settings(uid).period || null});
    if (route === '/preferences' && method === 'PUT') return json(res,200,{ok:true,period:store.savePeriodPreferences(uid,await body(req))});
    if (route === '/fx' && method === 'GET') return json(res, 200, { ok: true, fx: await refreshBookkeepingFx(store, uid) });
    if (route === '/fx/refresh' && method === 'POST') return json(res, 200, { ok: true, fx: await refreshBookkeepingFx(store, uid) });
    if (route === '/state' && method === 'GET') {
      const history=historicalFx(getDatabase()), allOriginal=store.entries(uid), permittedAccounts=canBookkeep(session,'accounts:view')?store.accounts(uid):null;
      const destinations=allOriginal.filter(e=>e.toAccountId && e.toAmount!=null).map(e=>({...e,currency:permittedAccounts?.find(a=>a.id===e.toAccountId)?.currency||'CNY'}));
      const ledgerAccount=permittedAccounts?.find(a=>a.id===url.searchParams.get('accountId'));
      const ledgerQuotes=ledgerAccount?allOriginal.filter(e=>e.accountId===ledgerAccount.id || e.toAccountId===ledgerAccount.id).map(e=>({...e,currency:ledgerAccount.currency})):[];
      await history.ensure([...allOriginal,...destinations,...ledgerQuotes]);
      const entries = store.entries(uid, Object.fromEntries(url.searchParams)).map(history.enrich);
      const balances=accountLedger(allOriginal,ledgerAccount,history.quote);
      for(const e of entries){if(balances.has(e.id))Object.assign(e,balances.get(e.id));delete e.balanceCheckpoint;}
      const offset = Math.max(0, Math.min(50000, Number(url.searchParams.get('offset')) || 0));
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 100));
      const all = allOriginal.map(history.enrich), accounts = permittedAccounts;
      const settings=store.settings(uid), fx=effectiveBookkeepingFx(settings);
      for(const e of all){if(e.toAccountId){const a=accounts?.find(a=>a.id===e.toAccountId);if(a){e.toHistoricalRate=history.quote(a.currency,e.date.slice(0,10))?.rate||null;if(e.toAmount!=null && !e.toHistoricalRate)e.toFxMissing=a.currency;}}}
      const budgetMonth=url.searchParams.get('month'), budgetData=budgetMonth?analyzeBookkeeping(all.filter(e=>e.date.startsWith(budgetMonth)),all,null,settings,{month:budgetMonth},undefined,fx.rates):null;
      const calculation=analyzeBookkeeping(entries,all,canBookkeep(session,'analysis:view')?accounts:null,settings,Object.fromEntries(url.searchParams),undefined,fx.rates);
      return json(res, 200, { ok: true, equivalentSummary:calculation.equivalentSummary, conversionMissing:calculation.billing.missingCurrencies, entries: entries.slice(offset, offset + limit), count: entries.length, summary: summarize(entries),
        budgetExpense: budgetData?(budgetData.billing.missingCurrencies.length?null:budgetData.equivalentSummary.totals.CNY?.expense||0):null,
        accounts: accounts || [], settings, fx,
        analysis: canBookkeep(session,'analysis:view') ? calculation : null,
        categoryTree: store.catalog.list(uid), accountGroups: canBookkeep(session,'accounts:view') ? store.catalog.groupList(uid) : [],
        books: [...new Set(all.map(e => e.book))], categories: [...new Set(all.map(e => e.category))],
        months: [...new Set(all.map(e => e.date.slice(0, 7)))].sort().reverse() });
    }
    if (route === '/accounts' && method === 'GET') return json(res, 200, { ok: true, accounts: store.accounts(uid) });
    if (route === '/categories' && method === 'GET') return json(res,200,{ok:true,categories:store.catalog.list(uid)});
    if (route === '/categories' && method === 'POST') return json(res,201,{ok:true,id:store.catalog.save(uid,await body(req))});
    if (route === '/categories/order' && method === 'PUT') { store.catalog.reorder(uid,'categories',(await body(req)).ids); return json(res,200,{ok:true}); }
    const category = /^\/categories\/([a-f0-9]{32})(\/merge)?$/.exec(route);
    if (category && method === 'PUT' && !category[2]) return json(res,200,{ok:true,id:store.catalog.save(uid,await body(req),category[1])});
    if (category && method === 'POST' && category[2]) return json(res,200,{ok:true,...store.catalog.merge(uid,category[1],(await body(req)).targetId)});
    if (category && method === 'DELETE' && !category[2]) { store.catalog.remove(uid,category[1]); return json(res,200,{ok:true}); }
    if (route === '/groups' && method === 'GET') return json(res,200,{ok:true,groups:store.catalog.groupList(uid)});
    if (route === '/groups' && method === 'POST') return json(res,201,{ok:true,id:store.catalog.saveGroup(uid,await body(req))});
    if (route === '/groups/order' && method === 'PUT') { store.catalog.reorder(uid,'groups',(await body(req)).ids); return json(res,200,{ok:true}); }
    const group = /^\/groups\/([a-f0-9]{32})(\/merge)?$/.exec(route);
    if (group && method === 'PUT' && !group[2]) return json(res,200,{ok:true,id:store.catalog.saveGroup(uid,await body(req),group[1])});
    if (group && method === 'DELETE' && !group[2]) { store.catalog.removeGroup(uid,group[1]); return json(res,200,{ok:true}); }
    if (group && method === 'POST' && group[2]) { store.catalog.removeGroup(uid,group[1],(await body(req)).targetId); return json(res,200,{ok:true}); }
    if (route === '/accounts/order' && method === 'PUT') { store.reorderAccounts(uid,(await body(req)).ids); return json(res,200,{ok:true}); }
    const archive = /^\/accounts\/([a-f0-9]{32})\/archive$/.exec(route);
    if (archive && method === 'POST') { store.archiveAccount(uid,archive[1],(await body(req)).archived); return json(res,200,{ok:true}); }
    if (route === '/entries' && method === 'POST') return json(res, 201, { ok: true, id: store.saveEntry(uid, await body(req)) });
    const entry = /^\/entries\/([a-f0-9]{32})$/.exec(route);
    if (entry && method === 'PUT') return json(res, 200, { ok: true, id: store.saveEntry(uid, await body(req), entry[1]) });
    if (entry && method === 'DELETE') { store.removeEntry(uid, entry[1]); return json(res, 200, { ok: true }); }
    if (route === '/accounts' && method === 'POST') return json(res, 201, { ok: true, id: store.saveAccount(uid, await body(req)) });
    const account = /^\/accounts\/([a-f0-9]{32})(\/adjust)?$/.exec(route);
    if (account && method === 'PUT' && !account[2]) return json(res, 200, { ok: true, id: store.saveAccount(uid, await body(req), account[1]) });
    if (account && method === 'POST' && account[2]) return json(res, 200, { ok: true, id: store.adjust(uid, account[1], await body(req)) });
    if (account && method === 'DELETE' && !account[2]) { store.removeAccount(uid, account[1]); return json(res, 200, { ok: true }); }
    if (route === '/settings' && method === 'PUT') return json(res, 200, { ok: true, settings: store.saveSettings(uid, await body(req)) });
    if (route === '/import/preview' && method === 'POST') {
      const now = Date.now(); for (const [k, v] of imports) if (now - v.at > ttl) imports.delete(k);
      if (imports.size >= 12) throw new Error('导入任务过多，请稍后重试');
      const parsed = await parseIcost(await body(req, true));
      for (const [k, v] of imports) if (v.uid === uid) imports.delete(k);
      const token = crypto.randomBytes(24).toString('hex');
      imports.set(token, { uid, at: now, rows: parsed.rows, errors: parsed.errors });
      return json(res, 200, { ok: true, token, count: parsed.rows.length, errors: parsed.errors.slice(0, 100), errorCount: parsed.errors.length,
        warnings: parsed.warnings, summary: summarize(parsed.rows), sample: parsed.rows.slice(0, 8).map(({ raw, sourceKey, ...e }) => e) });
    }
    if (route === '/import/confirm' && method === 'POST') {
      const input = await body(req), pending = imports.get(input.token);
      if (!pending || pending.uid !== uid || Date.now() - pending.at > ttl) throw new Error('导入预览已过期，请重新选择文件');
      if (pending.errors.length) throw new Error('存在无效行，请修正文件后重新导入');
      const names = new Set(store.accounts(uid).map(a => a.name));
      const createsAccounts = input.accounts?.length || pending.rows.some(r => [r.accountName, r.toAccountName].some(n => n && !names.has(n)));
      if (createsAccounts && !canBookkeep(session, 'accounts:edit')) return json(res, 403, { ok: false, error: '创建导入账户或账户快照需要账户编辑权限' });
      const result = store.importRows(uid, pending.rows, input.accounts || []); imports.delete(input.token);
      return json(res, 200, { ok: true, ...result });
    }
    if (route === '/export' && method === 'GET') {
      const buffer = await exportIcost(store.entries(uid, Object.fromEntries(url.searchParams)));
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="bookkeeping.xlsx"', 'Content-Length': buffer.length }); res.end(buffer); return;
    }
    return json(res, 404, { ok: false, error: '记账接口不存在' });
  } catch (e) {
    if (e.code?.startsWith('SQLITE_')) { console.error('[bookkeeping]', e.code); return json(res, 500, { ok: false, error: '记账保存失败，请稍后重试' }); }
    return json(res, 400, { ok: false, error: e.message });
  }
}
