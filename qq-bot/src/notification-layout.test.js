import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('all business notification hosts share the responsive flow without changing ownership or visibility', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const area = html.slice(html.indexOf('<div class="business-panels">'), html.indexOf('<section class="channel-grid">'));
  for (const id of ['business-grid', 'shopping-notifications', 'users-notifications', 'chain-notifications']) assert.ok(area.includes('id="' + id + '"'));
  for (const id of ['shopping-notifications', 'users-notifications', 'chain-notifications']) assert.match(area, new RegExp('id="' + id + '"[^>]*hidden'));
  const css = fs.readFileSync(new URL('../public/integrations.css', import.meta.url), 'utf8');
  assert.match(css, /\.business-panels[^}]*columns:420px/);
  assert.match(css, /\.business-panels \.business-card[^}]*break-inside:avoid/);
});
