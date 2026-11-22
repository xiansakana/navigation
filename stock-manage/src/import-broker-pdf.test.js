import test from 'node:test';
import assert from 'node:assert/strict';
import { combinePdfTrade, matchesPdfTrade, parseBrokerPdf, parseBrokerPdfLines } from './import-broker-pdf.js';
import { mergeBbaeTrades } from './import-bbae.js';

const stockNote = [
  'Stock Contract Note', 'Investment Account Number : ZATEST', 'Stock Name', 'ETF', 'Stock Code', '03170',
  'Transaction Type', 'Sell', 'Contract Date', '06 Jul 2026', 'Settlement Date', '08 Jul 2026',
  'Average Execution Price (Per Unit)', 'HKD 13.1600', 'Execution Quantities', '350',
  'Total Consideration Amount', 'HKD 4,606.00', 'Settlement Amount', 'HKD 4,587.42',
  'Order Reference', 'TEST-0199', 'ZA Bank Limited'
];

function textPdf(lines) {
  const stream = ['BT /F1 9 Tf 1 0 0 1 40 760 Tm', ...lines.map((line, i) =>
    (i ? '0 -20 Td ' : '') + '(' + line.replace(/[()\\]/g, '\\$&') + ') Tj'), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((obj, index) => {
    const offset = pdf.length;
    pdf += (index + 1) + ' 0 obj\n' + obj + '\nendobj\n';
    return offset;
  });
  const start = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF\n';
  return Buffer.from(pdf);
}

function batchPdf(...files) {
  return Buffer.concat([Buffer.from('STOCKPDF1\n'), ...files.flatMap(file => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(file.length);
    return [length, file];
  })]);
}

test('batch extracts real PDF text, validates settlement fees, and deduplicates the same document', async () => {
  const pdf = textPdf(stockNote);
  const batch = batchPdf(pdf, pdf);
  const rows = await parseBrokerPdf(batch);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, '03170.HK');
  assert.equal(rows[0].commission, 18.58);
  assert.equal(rows[0].cash_effective_at, '2026-07-08T15:00:00+08:00');
  assert.equal(rows.pdfImportInfo.sourceCount, 2);
  assert.equal(rows.pdfImportInfo.excluded[0].count, 1);
  await assert.rejects(parseBrokerPdf(batch.subarray(0, -1)), /不完整/);
});

test('recognizes USD and HKD in one batch while keeping one source account per currency', async () => {
  const hk = textPdf(stockNote);
  const us = textPdf(stockNote.map(line => line.replace('03170', 'TSLA').replace('HKD', 'USD')
    .replace('ZATEST', 'ANOTHER-US-ACCOUNT').replace('TEST-0199', 'TEST-0200')));
  const rows = await parseBrokerPdf(batchPdf(hk, us));
  assert.deepEqual(rows.pdfImportInfo.currencies, ['HKD', 'USD']);
  assert.equal(rows.find(row => row.symbol === '03170.HK').currency, 'HKD');
  assert.equal(rows.find(row => row.symbol === 'TSLA').currency, 'USD');
  const otherHk = textPdf(stockNote.map(line => line.replace('ZATEST', 'DIFFERENT-HK-ACCOUNT').replace('TEST-0199', 'TEST-0201')));
  await assert.rejects(parseBrokerPdf(batchPdf(hk, otherHk)), /HKD 单据属于不同的券商账户/);
});

test('Chief supports displaced quote fields and validates the explicit fee subtotal', () => {
  const lines = ['Chief Securities Limited', '环球股票综合成交单及日结单', '户口编号 : MTEST1', '股票交易记录 (USD)',
    'CDED 217.231400', '15/10/26 16/10/26 S911123456 卖 出 NVDA 网上交易 0.1129 24.53 23.52',
    'NVIDIA CORP', '平台使用费 : 1.01 小结 : 1.01', '总卖出金额 : 23.52'];
  const [row] = parseBrokerPdfLines(lines).rows;
  assert.equal(row.symbol, 'NVDA');
  assert.equal(row.shares, 0.1129);
  assert.equal(row.price, 217.2314);
  assert.equal(row.commission, 1.01);
  assert.equal(row.broker_net, 23.52);
  const incorrect = lines.map(line => line.replace('小结 : 1.01', '小结 : 0.99'));
  assert.throws(() => parseBrokerPdfLines(incorrect), /费用小结不一致/);
});

test('PDF matches the old cash-dividend gross and tax on its record date without counting the net twice', () => {
  const incoming = parseBrokerPdfLines([
    'Stock Corporate Action Advice', 'Account Number : ZATEST', 'Stock Code', 'AVGO', 'Event Type', 'Cash Dividend',
    'Record Date', '22 Jun 2026', 'Payment Date', '01 Jul 2026', 'Gross Dividend Amount', 'USD 0.02',
    'Withholding Tax', 'USD 0.01', 'Dividend Collection Fee', 'USD 0.00', 'Dividend Amount(Net)', 'USD 0.01', 'ZA Bank Limited'
  ]).rows;
  const gross = { id: 'dividend', account_id: 'a', symbol: 'AVGO', type: 'other', other_category: '股息', total_amount: 0.02,
    shares: 1, price: 0, commission: 0, trade_date: '2026-06-22T08:00:00+08:00', historicalBackfill: true };
  const tax = { ...gross, id: 'tax', other_category: '股息税', total_amount: -0.01 };
  const options = { matchManualTrade: matchesPdfTrade, combineTrade: combinePdfTrade };
  const planned = mergeBbaeTrades([gross, tax], incoming, 'a', options);
  assert.equal(planned.summary.skipped, 1);
  assert.equal(planned.trades.length, 2);
  assert.equal(planned.trades[0].total_amount, 0.02);
  assert.equal(planned.trades[0].trade_date, gross.trade_date);
  assert.equal(planned.trades[0].historicalBackfill, true);
  assert.equal(mergeBbaeTrades(planned.trades, incoming, 'a', options).summary.skipped, 1);
});
