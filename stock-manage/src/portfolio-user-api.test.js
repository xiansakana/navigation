import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

test('real API rejects anonymous access and scopes portfolio, updates, import, export, review and summary', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-user-api-'));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ server: { host: '127.0.0.1', port }, dbPath: path.join(directory, 'db.sqlite'), dataFile: path.join(directory, 'empty.json') }));
  const server = fileURLToPath(new URL('./server.js', import.meta.url));
  const child = spawn(process.execPath, [server], { cwd: directory, env: { ...process.env, NAVIGATION_DB_PATH: path.join(directory, 'db.sqlite') }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/api`;
  const call = (url, user, method = 'GET', body) => fetch(base + url, { method, headers: { ...(user ? { 'x-portal-user-id': user, 'x-portal-permissions': Buffer.from('["*"]').toString('base64url') } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready);
    assert.equal((await call('/portfolio')).status, 401);
    assert.equal((await call('/portfolio', 'bad id')).status, 401);
    let response = await call('/cash', 'a', 'PUT', { cashUsd: 1000, userId: 'b' });
    assert.equal(response.status, 200);
    response = await call('/trades', 'a', 'POST', { type: 'buy', symbol: 'AAPL', name: 'Apple', shares: 1, price: 10, userId: 'b', trade_date: '2026-01-01T00:00:00Z' });
    const a = await response.json();
    assert.equal(a.trades.length, 1);
    const id = a.trades[0].id;
    const b = await (await call('/portfolio?userId=a', 'b')).json();
    assert.equal(b.trades.length, 0);
    assert.equal(b.cashUsd, 0);
    assert.equal((await call('/trades/' + id, 'b', 'DELETE')).status, 404);
    assert.equal((await call('/trades/' + id, 'b', 'PUT', { type: 'buy', symbol: 'AAPL', name: 'Apple', shares: 1, price: 2 })).status, 404);
    assert.deepEqual(await (await call('/trades/summary', 'b')).json(), []);
    assert.equal((await (await call('/trades/review', 'b')).json()).currencies.length, 0);
    const workbook = XLSX.read(Buffer.from(await (await call('/trades/export', 'b')).arrayBuffer()));
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]).length, 0);
    const payload = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(payload, XLSX.utils.aoa_to_sheet([['时间','类型','交易方向','其它类别','代码','名称','股数','价格','金额','手续费'],['2026-01-02 12:00:00','股票','买入','','GOOG','Google',1,20,20,0]]), '交易记录');
    const imported = await fetch(base + '/trades/import?mode=replace', { method: 'POST', headers: { 'x-portal-user-id': 'b', 'Content-Type': 'application/octet-stream' }, body: XLSX.write(payload, { type: 'buffer', bookType: 'xlsx' }) });
    assert.equal(imported.status, 200);
    assert.equal((await (await call('/portfolio', 'a')).json()).trades[0].symbol, 'AAPL');
    assert.equal((await (await call('/portfolio', 'b')).json()).trades[0].symbol, 'GOOG');
    assert.match((await call('/portfolio', 'a')).headers.get('cache-control'), /no-store/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode != null ? resolve() : child.once('exit', resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
