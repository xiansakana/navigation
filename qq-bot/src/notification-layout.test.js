import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('all business notification hosts share the responsive flow without changing ownership or visibility', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const area = html.slice(html.indexOf('<div class="business-panels">'), html.indexOf('<section class="channel-grid">'));
  for (const id of ['business-grid', 'shopping-notifications', 'users-notifications', 'chain-notifications']) assert.ok(area.includes('id="' + id + '"'));
  for (const id of ['shopping-notifications', 'users-notifications', 'chain-notifications']) assert.match(area, new RegExp('id="' + id + '"[^>]*hidden'));
  const css = fs.readFileSync(new URL('../public/integrations.css', import.meta.url), 'utf8');
  assert.match(css, /\.business-panels[^}]*repeat\(auto-fit,minmax/);
  assert.match(css, /@container\(max-width:480px\)/);
  assert.ok(html.includes('business-layout.js?v=1'));
});

test('card height changes and newly loaded modules recalculate grid spans', () => {
  let height = 100, callback, frame, cards;
  const card = { style:{}, getClientRects:()=>[{}], getBoundingClientRect:()=>({height}) };
  cards = [card];
  const host = { classList:{add(){}}, querySelectorAll:()=>cards };
  vm.runInNewContext(fs.readFileSync(new URL('../public/business-layout.js',import.meta.url),'utf8'), {
    document:{querySelector:()=>host}, window:{addEventListener(){}},
    getComputedStyle:()=>({rowGap:'18px',gridAutoRows:'1px'}),
    requestAnimationFrame: fn => { frame=fn;return 1; },
    ResizeObserver:class { constructor(fn){callback=fn;} observe(){} unobserve(){} },
    MutationObserver:class { observe(){} }
  });
  frame(); assert.equal(card.style.gridRowEnd,'span 7');
  height=300; callback(); frame(); assert.equal(card.style.gridRowEnd,'span 17');
  const added={...card,style:{}};cards.push(added);callback();frame();assert.equal(added.style.gridRowEnd,'span 17');
});
