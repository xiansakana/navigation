import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import { createBookkeepingStore } from './bookkeeping-store.js';

test('date preferences persist per user without changing budgets or rates and reject invalid dates',()=>{
  const db=new Database(':memory:');
  try {
    const s=createBookkeepingStore(db);
    s.saveSettings('a',{budgets:{'2026-10':100},rates:{USD:7}});
    const value={kind:'range',anchor:'2026-10-14',rangeStart:'2025-07-01',rangeEnd:'2026-10-14'};
    s.savePeriodPreferences('a',{...value,budgets:{'2026-10':999}});
    assert.deepEqual(createBookkeepingStore(db).settings('a').period,value);
    assert.equal(s.settings('a').budgets['2026-10'],100);
    assert.equal(s.settings('a').rates.USD,7);
    assert.equal(s.settings('b').period,undefined);
    assert.throws(()=>s.savePeriodPreferences('a',{...value,kind:'bad'}),/无效/);
    assert.throws(()=>s.savePeriodPreferences('a',{...value,rangeEnd:'2026-02-30'}),/日期/);
    assert.throws(()=>s.savePeriodPreferences('a',{...value,rangeStart:'2027-01-01'}),/晚于/);
  } finally {db.close();}
});

test('custom range survives month/all switches and temporary statistics drill-down',()=>{
  const nodes=new Map(), saved=[];
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='period-kind'?'month':'',classList:{toggle(){}},addEventListener(){}});return nodes.get(id);};
  const context={window:{},document:{querySelectorAll:()=>[]},Date};
  vm.runInNewContext(fs.readFileSync(new URL('../public/bookkeeping/periods.js',import.meta.url),'utf8'),context);
  const p=context.window.createBookkeepingPeriods({$,load(){},clearFocus(){},save:value=>saved.push(value)});
  p.hydrate({kind:'range',anchor:'2026-10-14',rangeStart:'2025-07-01',rangeEnd:'2026-10-14'});
  p.choose('month');p.choose('all');p.choose('range');
  assert.equal(p.query().start,'2025-07-01');assert.equal(p.query().end,'2026-10-14');
  const count=saved.length;
  p.focusDate({day:'2026-10-01'});
  assert.equal(saved.length,count);
  p.choose('range');
  assert.equal(p.query().start,'2025-07-01');
});

test('today returns to the current Shanghai week, month or year, persists the choice and stays current across midnight',()=>{
  const nodes=new Map(),saved=[];let stamp=Date.parse('2026-10-28T16:10:00Z'),loads=0,clears=0;
  class Clock extends Date {constructor(...args){super(...(args.length?args:[stamp]));}static now(){return stamp;}}
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='period-kind'?'month':'',classList:{toggle(){}},addEventListener(){}});return nodes.get(id);};
  const context={window:{},document:{querySelectorAll:()=>[]},Date:Clock,Intl};
  vm.runInNewContext(fs.readFileSync(new URL('../public/bookkeeping/periods.js',import.meta.url),'utf8'),context);
  const p=context.window.createBookkeepingPeriods({$,load(){loads++;},clearFocus(){clears++;},save:value=>saved.push(value)});
  p.hydrate({kind:'month',anchor:'2025-01-01',rangeStart:'2025-07-01',rangeEnd:'2026-10-14'});
  for(const [kind,start,end] of [['week','2026-10-26','2026-11-01'],['month','2026-10-01','2026-10-31'],['year','2026-01-01','2026-12-31']]){
    p.choose(kind);$('period-anchor').value='2025-01-01';const before={saved:saved.length,loads,clears};
    $('period-today').onclick();
    assert.equal($('period-anchor').value,'2026-10-29');assert.equal($('period-kind').value,kind);
    assert.equal(p.query().start,start);assert.equal(p.query().end,end);
    assert.equal(saved.at(-1).anchor,'2026-10-29');assert.equal(saved.length,before.saved+1);assert.equal(loads,before.loads+1);assert.equal(clears,before.clears+1);
  }
  stamp=Date.parse('2026-10-31T16:10:00Z');p.choose('month');$('period-today').onclick();
  assert.equal($('period-anchor').value,'2026-11-01');assert.equal(p.query().start,'2026-11-01');assert.equal(p.query().end,'2026-11-30');
  p.choose('range');assert.equal(p.query().start,'2025-07-01');assert.equal(p.query().end,'2026-10-14');
});
