import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

function fixture(permission=true) {
  const dom=new JSDOM(fs.readFileSync(new URL('../public/bookkeeping/index.html',import.meta.url),'utf8'),{runScripts:'outside-only'}),w=dom.window;
  const $=id=>w.document.getElementById(id),frames=new Map(),saved=[];
  let frameId=0,y=0,panelY=1200,loads=0;
  Object.defineProperty(w,'scrollY',{get:()=>y});
  w.scrollTo=options=>{y=options.top;};
  w.requestAnimationFrame=callback=>{frames.set(++frameId,callback);return frameId;};
  w.HTMLElement.prototype.getBoundingClientRect=function(){
    if(this.classList.contains('navbar'))return {bottom:64};
    if(this.classList.contains('bk-shell'))return {left:0,width:1400};
    if(this.id==='period-selector' || this.style.height==='120px')return {bottom:500-y,height:120};
    if(this.id==='period-dock')return {bottom:120};
    if(this.id==='asset-overview')return {top:panelY-y,bottom:panelY+800-y};
    return {top:0,bottom:0,height:0};
  };
  w.HTMLElement.prototype.getClientRects=function(){return this.id==='asset-overview'?[this.getBoundingClientRect()]:[];};
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
  for(const name of ['periods','period-dock'])w.eval(fs.readFileSync(new URL('../public/bookkeeping/'+name+'.js',import.meta.url),'utf8'));
  const periods=w.createBookkeepingPeriods({$,load(){loads++;},clearFocus(){},save:value=>saved.push(value)});
  periods.hydrate({kind:'month',anchor:'2026-10-01',rangeStart:'2026-10-01',rangeEnd:'2026-10-31'});
  const dock=w.createBookkeepingPeriodDock({$,can:()=>permission});
  const flush=async()=>{await Promise.resolve();for(let i=0;frames.size && i<10;i++){const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());await Promise.resolve();}assert.equal(frames.size,0);};
  const scroll=async value=>{y=value;w.dispatchEvent(new w.Event('scroll'));await flush();};
  return {dom,w,$,dock,periods,saved,flush,scroll,get loads(){return loads;},movePanel(value){panelY=value;}};
}

test('chart time bar appears only after the full selector scrolls away on authorized statistics or assets tabs',async()=>{
  const f=fixture();
  try {
    f.dock.setTab('accounts');assert.equal(f.$('period-dock').classList.contains('hidden'),true);
    await f.scroll(1000);assert.equal(f.$('period-dock').classList.contains('hidden'),false);
    assert.equal(f.$('period-dock').style.top,'64px');
    f.dock.setTab('stats');assert.equal(f.$('period-dock').classList.contains('hidden'),false);
    f.dock.setTab('entries');assert.equal(f.$('period-dock').classList.contains('hidden'),true);
    f.dock.setTab('accounts');await f.scroll(0);assert.equal(f.$('period-dock').classList.contains('hidden'),true);
  } finally {f.dom.window.close();}
  const denied=fixture(false);
  try {denied.dock.setTab('accounts');await denied.scroll(1000);assert.equal(denied.$('period-dock').classList.contains('hidden'),true);}
  finally {denied.dom.window.close();}
});

test('docked arrows and date picker share the existing filters, preserve saved ranges and restore controls after closing',async()=>{
  const f=fixture();
  try {
    f.dock.setTab('accounts');await f.scroll(1000);
    f.$('period-dock').querySelector('[data-period-step="prev"]').click();await f.flush();
    assert.equal(f.periods.query().start,'2026-09-01');assert.equal(f.loads,1);assert.equal(f.saved.at(-1).anchor,'2026-09-01');
    assert.match(f.$('period-dock').textContent,/2026-09-01/);
    const original=f.$('period-selector');f.$('period-dock').querySelector('.bk-period-dock-caption').click();
    assert.equal(f.$('period-dock-editor').open,true);assert.equal(original.closest('dialog').id,'period-dock-editor');
    assert.equal(f.w.document.querySelectorAll('#period-selector').length,1);
    original.querySelector('[data-period="range"]').click();
    f.$('range-start').value='2026-08-01';f.$('range-end').value='2026-09-20';f.$('range-end').dispatchEvent(new f.w.Event('change',{bubbles:true}));await f.flush();
    assert.equal(f.saved.at(-1).rangeEnd,'2026-09-20');
    assert.equal(f.$('period-dock').querySelector('[data-period-step="next"]').disabled,true);
    f.$('period-dock-editor').close();await f.flush();assert.equal(original.parentElement.className,'bk-shell');
    assert.equal(f.periods.query().start,'2026-08-01');assert.equal(f.periods.query().end,'2026-09-20');
  } finally {f.dom.window.close();}
});

test('date reload restores the visible chart offset and does not scroll a different tab',async()=>{
  const f=fixture();
  try {
    f.dock.setTab('accounts');await f.scroll(1000);
    const restore=f.dock.capturePosition();assert.equal(typeof restore,'function');
    f.movePanel(1450);restore();await f.flush();assert.equal(f.w.scrollY,1250);
    const stale=f.dock.capturePosition();f.dock.setTab('stats');f.movePanel(1600);stale();await f.flush();assert.equal(f.w.scrollY,1250);
  } finally {f.dom.window.close();}
});

test('a small visible insight fragment does not take the scroll anchor from the main chart',async()=>{
  const f=fixture();
  try {
    let chartY=1300;
    const bounds=f.w.HTMLElement.prototype.getBoundingClientRect;
    f.w.HTMLElement.prototype.getBoundingClientRect=function(){
      if(this.matches('#stats-view > article')) {
        if(this.querySelector('#spending-insights'))return {top:700-f.w.scrollY,bottom:1160-f.w.scrollY};
        if(this.querySelector('#billing-charts'))return {top:chartY-f.w.scrollY,bottom:chartY+600-f.w.scrollY};
      }
      return bounds.call(this);
    };
    const rects=f.w.HTMLElement.prototype.getClientRects;
    f.w.HTMLElement.prototype.getClientRects=function(){return this.matches('#stats-view > article')?[this.getBoundingClientRect()]:rects.call(this);};
    f.dock.setTab('stats');await f.scroll(1000);
    const restore=f.dock.capturePosition();chartY+=200;restore();await f.flush();
    assert.equal(f.w.scrollY,1200);
  } finally {f.dom.window.close();}
});
