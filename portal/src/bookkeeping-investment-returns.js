import { TRANSFER_TYPES } from './bookkeeping-store.js';

const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const previousDate = date => new Date(Date.parse(date + 'T12:00:00Z') - 86400000).toISOString().slice(0,10);
const note = '综合投资收益（估算）＝观测资产变化－账单净资金流－余额调整。使用计入总资产且未被排除的账户，包含证券估值、股息及外币存量汇率变化；已记作普通收入或支出的项目不重复计入收益。内部转账本金不计资金流，手续费按账单支出扣除；范围外转入转出按账单日汇率扣除。未记录的资金变动也会进入差额，因此不等同券商收益或投资收益率。仅使用真实估值快照和今日暂估，不从早期反推资产或账面切换差额生成收益；未采集日期不补造日收益。';

// Observations must contain the retained account details, never a rounded total
// minus rounded exclusions. Do not use ledger-reconstructed points as valuations.
export function investmentReturns(observations, entries, filter = {}, today, events = []) {
  const empty = reason => ({points:[],period:null,note:note+' '+reason});
  if (!observations.length) return empty('尚无可用估值快照，至少需要两个可比较的观测点。');
  const start = filter.start || (filter.month ? filter.month+'-01' : observations[0].date);
  const requestedEnd = filter.end || (filter.month ? new Date(Date.UTC(Number(filter.month.slice(0,4)),Number(filter.month.slice(5,7)),0)).toISOString().slice(0,10) : today);
  const end = requestedEnd < today ? requestedEnd : today;
  if (start > end) return empty('所选范围尚无可用估值。');
  const openingDate=previousDate(start), prior=observations.find(p=>p.date===openingDate);
  let selected=[...(prior?[prior]:[]),...observations.filter(p=>p.date>=start && p.date<=end)];
  if (selected.length<2) return empty('所选范围不足两个估值观测点；早期账单反推段不能计算真实投资收益。');
  const signature=p=>JSON.stringify(p.accounts.map(a=>[a.id,a.currency,a.source||'ledger']).sort((a,b)=>a[0].localeCompare(b[0])));
  let segmentStart=0;
  for(let i=1;i<selected.length;i++) if(signature(selected[i])!==signature(selected[i-1]) || events.some(e=>Date.parse(e.at)>Date.parse(selected[i-1].capturedAt) && Date.parse(e.at)<=Date.parse(selected[i].capturedAt)))segmentStart=i;
  selected=selected.slice(segmentStart);
  if(selected.length<2) return empty('最近发生账户口径变更或证券现金核对，变更后尚不足两个可比观测点，暂不计算收益。');
  const first=selected[0],last=selected.at(-1);
  if(!first.accounts.length) return empty('所选口径没有计入总资产的账户。');
  if (selected.some(p=>p.accounts.some(a=>!Number.isFinite(a.balance)||!(a.rate>0)))) return empty('估值余额或汇率不完整，暂不计算收益。');
  const accounts=new Map(first.accounts.map(a=>[a.id,a])),ids=new Set(accounts.keys());
  const bills=entries.filter(e=>e.date.slice(0,10)>first.date && e.date.slice(0,10)<=last.date);
  const changes=new Map();
  for (const e of bills) {
    const from=ids.has(e.accountId),to=ids.has(e.toAccountId);
    if (!e.accountId && !e.toAccountId) return empty('观测范围内存在未关联账户的账单，无法确认其是否影响资产，补齐账户后再计算。');
    if (!from && !to) continue;
    if(e.historical) return empty('观测区间内存在不影响账户余额的历史导入账单，无法确认与估值的衔接，请核对后选择可比范围。');
    const rate=e.historicalRate || (e.currency==='CNY'?1:null);
    if (e.fxMissing || !(rate>0)) return empty('观测范围内缺少账单历史汇率，暂不计算收益。');
    const principal=Number.isFinite(e.cnyAmount)?e.cnyAmount:e.amount*rate;
    const fee=Number.isFinite(e.cnyFee)?e.cnyFee:(e.fee||0)*rate;
    let flow=0,adjustment=0;
    if (TRANSFER_TYPES.includes(e.type)) {
      if (from && to) flow=-fee;
      else if (from) flow=-principal-fee;
      else {
        const currency=accounts.get(e.toAccountId).currency;
        const destinationRate=e.toHistoricalRate || (currency==='CNY'?1:null);
        if (e.toAmount==null && currency!==e.currency) return empty('跨范围的跨币种转账缺少到账金额，不能以等值估算投资收益。');
        if (e.toAmount!=null && (!(destinationRate>0)||e.toFxMissing)) return empty('转入账户的历史汇率缺失，暂不计算收益。');
        flow=e.toAmount!=null?e.toAmount*destinationRate:principal;
      }
    } else if (from) {
      if (e.type==='余额调整') {adjustment=principal;flow=-fee;}
      else flow=['支出','已报销'].includes(e.type)?-principal-fee:principal-fee;
    }
    const date=e.date.slice(0,10),change=changes.get(date)||{flow:0,adjustment:0};
    change.flow+=flow;change.adjustment+=adjustment;changes.set(date,change);
  }
  const balance=p=>round(p.accounts.reduce((sum,a)=>sum+a.balance*a.rate,0));
  const opening=balance(first),points=[{date:first.date,currency:'CNY',profit:0,source:first.source,periodBoundary:'opening'}];
  let netFlow=0,adjustments=0;
  for(let i=1;i<selected.length;i++) {
    const p=selected[i];
    for(const [date,c] of changes) if(date>selected[i-1].date && date<=p.date){netFlow+=c.flow;adjustments+=c.adjustment;}
    points.push({date:p.date,currency:'CNY',profit:round(balance(p)-opening-round(netFlow)-round(adjustments)),source:p.source});
  }
  return {points,period:{start,end,openingAsOf:first.date,closingAsOf:last.date,opening,closing:balance(last),
    assetChange:round(balance(last)-opening),netFlow:round(netFlow),adjustments:round(adjustments),profit:points.at(-1).profit,
    partial:segmentStart>0 || (!!(filter.start||filter.month)&&first.date>openingDate) || last.date<end,provisional:last.source==='current'},
    note:note+' 实际观测区间：'+first.date+' 至 '+last.date+'；起点为收益零基准。'+(segmentStart?' 已从最近账户口径变更或证券现金核对后的首个估值重新起算，不将校正差额算作收益。':first.date>openingDate?' 所选范围前段没有可比快照，仅展示有观测的部分。':'')};
}
