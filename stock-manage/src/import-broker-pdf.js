import { createHash } from 'node:crypto';
import { Decimal, roundDecimal } from '../../shared/portfolio-decimal.js';
import { normalizeSymbol } from './markets.js';
import { tradeCalendarDate } from './trades.js';

const batchMagic = Buffer.from('STOCKPDF1\n');
export const pdfBatchLimit = 30;
const pdfHeader = file => file.subarray(0, 5).toString('ascii') === '%PDF-';
export const isBrokerPdf = buffer => pdfHeader(buffer) || buffer.subarray(0, batchMagic.length).equals(batchMagic);
const hash = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const numeric = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const number = value => Number(value.replaceAll(',', ''));
const money = (text, label) => {
  const match = new RegExp(String.raw`${label}\s*(USD|HKD)\s*(${numeric})`, 'i').exec(text);
  if (!match) throw new Error('缺少' + label + '金额');
  return { currency: match[1].toUpperCase(), value: number(match[2]) };
};
const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
function dateKey(year, month, day) {
  const key = [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Number.isFinite(Date.parse(key)) || new Date(key).toISOString().slice(0, 10) !== key) {
    throw new Error('单据日期无效');
  }
  return key;
}

const at = day => day + 'T15:00:00+08:00';
function zaDate(text, label) {
  const match = new RegExp(String.raw`${label}\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{4})`, 'i').exec(text);
  if (!match) throw new Error('缺少' + label + '日期');
  const month = match[2][0].toUpperCase() + match[2].slice(1).toLowerCase();
  return dateKey(match[3], months.indexOf(month) + 1, match[1]);
}

function chiefDate(value) {
  const [day, month, year] = value.split('/');
  return dateKey(year.length === 2 ? '20' + year : year, month, day);
}

function readField(text, pattern, label) {
  const value = pattern.exec(text)?.[1];
  if (!value) throw new Error('缺少' + label);
  return value.trim();
}

function stockSymbol(code, currency) {
  const symbol = currency === 'HKD' && /^\d{1,5}$/.test(code) ? code.padStart(5, '0') + '.HK' : code;
  if (!(currency === 'HKD' ? /^\d{5}\.HK$/ : /^[A-Z][A-Z0-9.-]{0,14}$/).test(symbol)) throw new Error('证券代码无效');
  return normalizeSymbol(symbol);
}

function charge(gross, net, type) {
  const fee = roundDecimal(new Decimal(net).minus(gross).times(type === 'buy' ? 1 : -1), 2);
  if (fee < 0) throw new Error('成交金额和交收金额方向不符');
  return fee;
}

function checkTrade(shares, price, gross, tolerance = 0.01) {
  if (!(shares > 0 && price > 0 && gross > 0) || new Decimal(shares).times(price).minus(gross).abs().gt(tolerance)) {
    throw new Error('成交数量、单价和金额无法核对');
  }
}

function record(broker, ref, fields) {
  const { day, settlement = day, ...values } = fields;
  const key = hash([broker, ref]);
  return {
    ...values, broker, broker_order_key: key, id: `${broker}-${key}`,
    trade_date: at(day), created_at: at(day), cash_effective_at: at(settlement), settlement_date: settlement
  };
}

function parseZa(lines) {
  const text = lines.join('\n').split(/\bImportant Notice\b/i)[0];
  const broker = 'za-pdf';
  const account = text.match(/(?:Investment )?Account Number\s*[账户投資投资号码號碼\s]*[:：]\s*([A-Z0-9-]+)/i)?.[1] || '';
  const stockFields = currency => {
    const code = readField(text, /Stock Code\s+([A-Z0-9.-]+)/i, '股票代码').toUpperCase();
    const name = text.match(/Stock Name\s+([^\n]+?)\s*\n(?:股票名称|股票名稱)/)?.[1] || code;
    return { symbol: stockSymbol(code, currency), name };
  };
  if (/^Stock Contract Note/i.test(text)) {
    const ref = readField(text, /Order Reference\s+([A-Z0-9-]+)/i, '交易编号');
    const day = zaDate(text, 'Contract Date');
    const settlement = zaDate(text, 'Settlement Date');
    const type = readField(text, /Transaction Type\s+(Buy|Sell)\b/i, '买卖方向').toLowerCase();
    const { currency, value: gross } = money(text, 'Total Consideration\\s+Amount');
    const net = money(text, 'Settlement Amount');
    const price = money(text, 'Average Execution Price\\s*\\(Per Unit\\)');
    const shares = number(readField(text, new RegExp(String.raw`Execution Quantities\s+(${numeric})`), '成交股数'));
    checkTrade(shares, price.value, gross);
    if ([net, price].some(value => value.currency !== currency)) throw new Error('股票成交单币种不一致');
    const reward = type === 'buy' && /first credit the redeemable amount[\s\S]*?same amount for settlement/i.test(text);
    const commission = charge(gross, net.value, type);
    return { account, rows: [record(broker, [account, ref], {
      ...stockFields(currency), type, currency, day, settlement, shares, price: price.value,
      total_amount: reward ? 0 : gross, commission: reward ? 0 : commission, broker_net: reward ? 0 : type === 'buy' ? -net.value : net.value,
      ...(reward ? { broker_category: 'Stockback 回赠', broker_gross_amount: gross, broker_settlement_amount: net.value } : {})
    })], warnings: reward ? ['Stockback 回赠保留单据成交价，新增份额不扣现金。匹配到已补录的回赠会保留原记录。'] : [] };
  }
  if (/^Investment Fund Contract Note/i.test(text)) {
    const ref = readField(text, /Transaction Reference\s+([A-Z0-9-]+)/i, '交易编号');
    const symbol = readField(text, /ISIN Code\s+(HK\d{10})/i, '基金 ISIN').toUpperCase();
    const name = text.match(/^基金名称\s+([^\n]+)$/m)?.[1] || text.match(/^Fund Name ([^\n]+)$/m)?.[1] || symbol;
    const action = readField(text, /Transaction Type\s+(Subscription|Redemption)\b/i, '基金交易类型');
    const type = action === 'Subscription' ? 'buy' : 'sell';
    const day = zaDate(text, 'Dealing Date');
    const settlement = zaDate(text, 'Confirmation Date');
    const { currency, value: gross } = money(text, type === 'buy' ? 'Subscription Amount\\s*\\(including fees\\)' : 'Redemption Amount');
    const fee = money(text, action + ' Fee');
    const price = money(text, 'Unit Price');
    const shares = number(readField(text, new RegExp(String.raw`No\.\s*of Units\s+(${numeric})`, 'i'), '确认份额'));
    const sharesValue = new Decimal(shares).times(price.value).toDecimalPlaces(2);
    const withFee = roundDecimal(new Decimal(gross).plus(fee.value), 2);
    const total = type === 'buy' ? roundDecimal(new Decimal(gross).minus(fee.value), 2)
      : sharesValue.eq(withFee) ? withFee : gross;
    checkTrade(shares, price.value, total, 0.05);
    if ([fee, price].some(value => value.currency !== currency)) throw new Error('基金成交单币种不一致');
    return { account, rows: [record(broker, [account, ref], {
      symbol, name, currency, day, settlement, type, shares, price: price.value, total_amount: total,
      commission: fee.value, broker_net: type === 'buy' ? -gross : roundDecimal(new Decimal(total).minus(fee.value), 2)
    })], warnings: ['众安基金成交单以交易日记份额、以确认日作为现金入账日。'] };
  }
  if (/^Stock Corporate Action Advice/i.test(text)) {
    if (!/Event Type\s+Cash Dividend/i.test(text)) return { account, excluded: '暂不支持该公司行动' };
    const { currency, value: gross } = money(text, 'Gross Dividend Amount');
    const tax = money(text, 'Withholding Tax');
    const fee = money(text, 'Dividend Collection Fee');
    const net = money(text, 'Dividend Amount\\s*\\(\\s*Net\\s*\\)');
    if ([tax, fee, net].some(value => value.currency !== currency)
      || roundDecimal(new Decimal(gross).minus(tax.value).minus(fee.value), 2) !== net.value) {
      throw new Error('股息、预扣税、代收费与净派发金额不一致');
    }
    if (!net.value) return { account, excluded: '现金股息净派发为零' };
    const stock = stockFields(currency);
    const day = zaDate(text, 'Payment Date');
    const recordDay = zaDate(text, 'Record Date');
    return { account, rows: [record(broker, [account, stock.symbol, 'dividend', day, recordDay], {
      ...stock, day, currency, type: 'other', other_category: '股息', shares: 1, price: 0, total_amount: net.value,
      commission: 0, broker_net: net.value, broker_gross_dividend: gross, broker_withholding_tax: tax.value,
      broker_dividend_fee: fee.value, broker_dividend_record_date: recordDay
    })], warnings: ['现金股息按净派发金额计入，保留毛息、预扣税及代收费供预览。'] };
  }
  if (/^IPO Allotment and Refund Advice/i.test(text)) {
    const shares = number(readField(text, new RegExp(String.raw`Allotted Quantity\s+(${numeric})`), '获分配数量'));
    if (!shares) return { account, excluded: '新股未获配，认购本金已退款' };
    const { currency, value: price } = money(text, 'Final Offer Price\\s*\\(per share\\)');
    const net = money(text, 'Final Subscription Amount');
    if (net.currency !== currency) throw new Error('新股分配通知书币种不一致');
    const stock = stockFields(currency);
    const day = zaDate(text, 'Payment Date');
    const gross = roundDecimal(new Decimal(shares).times(price), 2);
    return { account, rows: [record(broker, [account, stock.symbol, 'ipo', day], {
      ...stock, day, currency, type: 'buy', shares, price, total_amount: gross, commission: charge(gross, net.value, 'buy'),
      broker_net: -net.value, broker_category: '新股配发'
    })] };
  }
  if (/^IPO\b/i.test(text)) return { account, excluded: '新股认购申请，需以最终分配通知书为准' };
  throw new Error('无法识别众安投资通知书类型');
}

const chiefDatePattern = String.raw`\d{1,2}/\d{1,2}/(?:\d{4}|\d{2})`;
const chiefRow = new RegExp(String.raw`^(${chiefDatePattern})\s+(${chiefDatePattern})\s+([BS]\d+)\s*([买買卖賣]\s*[入出])\s+(.+)$`);
const chiefAmounts = new RegExp(String.raw`^(.*?)\s+(${numeric})\s+(${numeric})\s+(\(?-?${numeric}\s*\)?)$`);
const chiefStandalonePrice = /^(?:([A-Z]{4})\s+)?(\d[\d,]*\.\d{3,8})$/;
function parseChief(lines) {
  const accountMatch = lines.join('\n').match(/户口编号\s*[:：]\s*([A-Z0-9]+)/);
  if (!accountMatch) throw new Error('未找到致富日结单账户编号');
  const account = accountMatch[1];
  let currency;
  const rows = [];
  let tradeHeaders = 0;
  let hasMovements = false;
  for (let i = 0; i < lines.length; i++) {
    if (/资金提存|資金提存/.test(lines[i])) hasMovements = true;
    const header = /^(?:股票)?交易记[录錄]\s*\(\s*(HKD|USD)\s*\)/.exec(lines[i]);
    if (header) {
      currency = header[1];
      tradeHeaders++;
      continue;
    }
    if (/^(?:总买入金额|總買入金額|投资组合|投資組合|账面现金结余)/.test(lines[i])) currency = undefined;
    const match = currency && chiefRow.exec(lines[i]);
    if (!match) {
      if (currency && new RegExp(String.raw`^${chiefDatePattern}\s+${chiefDatePattern}`).test(lines[i])) throw new Error('无法完整读取致富成交行');
      continue;
    }
    const [, when, settle, ref, side, details] = match;
    const type = /^[买買]/.test(side) ? 'buy' : 'sell';
    if ((ref[0] === 'B') !== (type === 'buy')) throw new Error('致富交易编号和买卖方向不一致');
    const amounts = chiefAmounts.exec(details);
    if (!amounts) throw new Error('致富成交金额或数量缺失');
    const [, described, rawShares, rawGross, rawNet] = amounts;
    const gross = number(rawGross), net = number(rawNet.replace(/[()\s-]/g, '')), shares = number(rawShares);
    const parts = described.split(/\s+/);
    const inlinePrice = /^\d[\d,]*\.\d{3,8}$/.test(parts.at(-1)) ? parts.pop() : '';
    const above = chiefStandalonePrice.exec(lines[i - 1] || '');
    const below = chiefStandalonePrice.exec(lines[i + 1] || '');
    const priceCandidates = [inlinePrice, above?.[2], below?.[2]].filter(Boolean);
    const price = priceCandidates.map(number).find(value => new Decimal(shares).times(value).minus(gross).abs().lte(0.01));
    if (!price) throw new Error('无法在致富日结单核对成交单价');
    const [code, ...nameParts] = currency === 'USD' && !above?.[1] ? parts.slice(1) : parts;
    const symbol = stockSymbol(code, currency);
    const name = currency === 'USD'
      ? lines[i + 1]?.match(/^[A-Z][A-Z0-9 .&,'()-]*[A-Z0-9](?=\s|$)/)?.[0] || symbol
      : nameParts.join(' ').replace(/\s*(?:网上交易|網上交易|电话交易|電話交易).*$/, '').trim() || symbol;
    const commission = charge(gross, net, type);
    const printedFee = lines.slice(i + 1, i + 4).find(line => /小结\s*[:：]|小結\s*[:：]/.test(line))
      ?.match(new RegExp(String.raw`小[结結]\s*[:：]\s*(${numeric})`))?.[1];
    if (printedFee != null && number(printedFee) !== commission) throw new Error('致富成交差额和费用小结不一致');
    rows.push(record('chief-pdf', [account, currency, ref], {
      day: chiefDate(when), settlement: chiefDate(settle), name, symbol, currency, type, shares, price,
      total_amount: gross, commission, broker_net: type === 'buy' ? -net : net
    }));
  }
  if (tradeHeaders && !rows.length) throw new Error('致富日结单的成交区没有可核对记录');
  return { account, rows, excluded: rows.length ? undefined : '致富日结单没有股票成交',
    warnings: hasMovements ? ['致富日结单的资金提存和账面余额仅供对账，不计入交易。'] : [] };
}

export function parseBrokerPdfLines(lines) {
  if (lines.some(line => /Chief Securities Limited|致富證券有限公司|致富证券有限公司/i.test(line))) {
    if (!lines.slice(0, 15).some(line => /日\s*[结結]\s*[单單]|Daily Statement/i.test(line))) throw new Error('请上传致富 dailystatement 日结单');
    return { broker: 'chief-pdf', ...parseChief(lines) };
  }
  if (lines.some(line => /ZA Bank Limited|眾安銀行有限公司|众安银行有限公司/i.test(line))) {
    return { broker: 'za-pdf', ...parseZa(lines) };
  }
  throw new Error('此 PDF 不是支持的众安投资通知书或致富日结单');
}

function splitBatch(buffer) {
  if (pdfHeader(buffer)) return [buffer];
  const files = [];
  let offset = batchMagic.length;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length || files.length >= pdfBatchLimit) throw new Error('PDF 批次格式无效，或者文件超过 30 份');
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    if (length < 5 || offset + length > buffer.length) throw new Error('PDF 批次文件不完整');
    const file = buffer.subarray(offset, offset + length);
    if (!pdfHeader(file)) throw new Error('同一批次只允许 PDF 文件');
    files.push(file);
    offset += length;
  }
  if (!files.length) throw new Error('请上传 PDF 文件');
  return files;
}

async function readPdf(file, password) {
  const { getDocument, VerbosityLevel } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: Uint8Array.from(file), password, verbosity: VerbosityLevel.ERRORS, useSystemFonts: false, isEvalSupported: false
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 12) throw new Error('单份交易 PDF 不能超过 12 页');
    const lines = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const { items } = await page.getTextContent();
      const rows = [];
      for (const item of items.filter(item => item.str?.trim()).sort((a, b) => b.transform[5] - a.transform[5])) {
        const x = item.transform[4], y = item.transform[5];
        let row = rows.at(-1);
        if (!row || row.y - y >= 2) {
          row = { y, items: [] };
          rows.push(row);
        }
        row.items.push({ x, text: item.str.replace(/\0/g, '') });
      }
      for (const row of rows) lines.push(row.items.sort((a, b) => a.x - b.x).map(item => item.text).join(' ').replace(/\s+/g, ' ').trim());
      page.cleanup();
    }
    return lines;
  } catch (error) {
    if (error.name === 'PasswordException') throw new Error('PDF 密码错误或缺失，请填写致富日结单密码再预览');
    throw error;
  } finally {
    await task.destroy();
  }
}

export async function parseBrokerPdf(buffer, password) {
  const files = splitBatch(buffer);
  const records = new Map(), excluded = new Map(), warnings = new Set();
  const fingerprints = new Set();
  let broker, currency, statementAccount;
  for (const [index, file] of files.entries()) {
    try {
      const fingerprint = createHash('sha256').update(file).digest('hex');
      if (fingerprints.has(fingerprint)) {
        const reason = '批次内重复文件';
        excluded.set(reason, (excluded.get(reason) || 0) + 1);
        continue;
      }
      fingerprints.add(fingerprint);
      const doc = parseBrokerPdfLines(await readPdf(file, password));
      if (broker && doc.broker !== broker) throw new Error('众安和致富文件请分批上传');
      if (statementAccount && doc.account && doc.account !== statementAccount) throw new Error('不同券商账户的单据请分批上传');
      broker = doc.broker;
      statementAccount ||= doc.account;
      if (doc.excluded) excluded.set(doc.excluded, (excluded.get(doc.excluded) || 0) + 1);
      for (const warning of doc.warnings || []) warnings.add(warning);
      for (const trade of doc.rows || []) {
        if (currency && trade.currency !== currency) throw new Error('美元和港币单据请按对应账户分批上传');
        currency = trade.currency;
        const old = records.get(trade.broker_order_key);
        if (old) {
          if (JSON.stringify(old) !== JSON.stringify(trade)) throw new Error('相同交易编号的文件内容不同，请核对后只保留正确版本');
          const reason = '批次内重复的成交或股息';
          excluded.set(reason, (excluded.get(reason) || 0) + 1);
        } else records.set(trade.broker_order_key, trade);
      }
    } catch (error) {
      throw new Error(`第 ${index + 1} 份 PDF：${error.message}`);
    }
  }
  const trades = [...records.values()].sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.id.localeCompare(b.id));
  trades.pdfImportInfo = { broker, currency, sourceCount: files.length,
    excluded: [...excluded].map(([reason, count]) => ({ reason, count })), warnings: [...warnings] };
  return trades;
}

export function matchesPdfTrade(old, incoming) {
  if (normalizeSymbol(old.symbol) !== incoming.symbol || old.type !== incoming.type) return false;
  if (old.currency && old.currency !== incoming.currency) return false;
  const day = incoming.trade_date.slice(0, 10);
  const oldDay = tradeCalendarDate(old.trade_date);
  if (old.type === 'other') return old.other_category === incoming.other_category && (oldDay === day
    || (oldDay === incoming.broker_dividend_record_date
      && [incoming.total_amount, incoming.broker_gross_dividend].includes(Number(old.total_amount))));
  if (oldDay !== day
      && !(incoming.currency === 'USD' && incoming.type !== 'other' && tradeCalendarDate(old.trade_date, 'America/New_York') === day)) return false;
  return Math.abs(Number(old.shares) - incoming.shares) < 1e-7;
}

export function combinePdfTrade(old, incoming, owned) {
  if (!old) return {};
  const legacy = old.broker_order_key !== incoming.broker_order_key || old.broker_preserved_trade_time;
  const retained = legacy ? {
    trade_date: old.trade_date,
    cash_effective_at: old.cash_effective_at,
    broker_preserved_trade_time: true
  } : {};
  if (incoming.broker_category === 'Stockback 回赠' && old.historicalBackfill) {
    return { ...retained, price: old.price, total_amount: old.total_amount, commission: old.commission };
  }
  if (incoming.broker_gross_dividend !== Number(old.total_amount) || incoming.total_amount === Number(old.total_amount)) return retained;
  const day = incoming.trade_date.slice(0, 10);
  const dividendDays = [day, tradeCalendarDate(old.trade_date)];
  const matchingTax = owned.some(trade => normalizeSymbol(trade.symbol) === incoming.symbol
    && dividendDays.includes(tradeCalendarDate(trade.trade_date)) && trade.other_category === '股息税'
    && -Number(trade.total_amount) === incoming.broker_withholding_tax);
  if (matchingTax && Number(old.commission || 0) === incoming.broker_dividend_fee) {
    return { ...retained, total_amount: old.total_amount, commission: old.commission };
  }
  if (matchingTax) throw new Error('已有同日股息税，但股息代收费未能核对，请先核对原记录');
  return retained;
}
