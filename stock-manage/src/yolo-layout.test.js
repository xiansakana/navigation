import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/yolo/index.html', import.meta.url), 'utf8');

test('backtest trades follow the result board and precede collection and option chain', () => {
  const board = html.indexOf('id="bt-drawdown"');
  const trades = html.indexOf('id="backtest-trades-card"');
  const recent = html.indexOf('id="recent-captures-card"');
  const chain = html.indexOf('id="option-chain-card"');
  assert.ok(board > 0 && board < trades && trades < recent && recent < chain);
  assert.equal((html.match(/id="trade-body"/g) || []).length, 1);
});

test('collection and full option chain have independent native disclosure headers', () => {
  for (const id of ['recent-captures-card', 'option-chain-card']) {
    assert.match(html, new RegExp(`<details[^>]*id="${id}"[^>]*>\\s*<summary class="quant-card-head">`));
  }
  assert.equal((html.match(/<details\b/g) || []).length, 2);
  assert.equal((html.match(/<\/details>/g) || []).length, 2);
});
