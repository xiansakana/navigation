import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSleeves, evaluate, newAlertKeys } from './playbook.js';
test('SOXL starts at -70 and reaches upper tier at -90, with exact boundary prices', () => {
  for (const [price, status, message] of [[50,'idle','−70%'],[30.01,'idle','−70%'],[30,'confirmed','已 −70%'],[10.01,'confirmed','已 −70%'],[10,'confirmed','已 −90%'],[5,'confirmed','已 −90%']]) {
    const s=evaluateSleeves(null,{H:100,price},10000,true)[0];
    assert.equal(s.status,status); assert.ok(s.recommendation.includes(message));
    assert.equal(s.trigger70,30); assert.equal(s.trigger90,10); assert.equal(s.trigger50,undefined);
  }
  assert.equal(evaluateSleeves(null,{H:100,price:5},10000,false)[0].status,'idle');
});
test('SOXL two thresholds use separate per-round keys without changing the notification event', () => {
  const input={cashUsd:10000,cashCny:0,usdCnyRate:7,soxlEnabled:true,
    qqq:{price:95,low:95,candles:[{h:100,c:95}]},soxl:{price:30,low:30,candles:[{h:100,c:30}]}};
  const first=evaluate(input).alerts.find(a=>a.symbol==='SOXL');
  const second=evaluate({...input,soxl:{...input.soxl,price:10}}).alerts.find(a=>a.symbol==='SOXL');
  assert.equal(first.event,'sleeveSoxl'); assert.equal(second.event,'sleeveSoxl');
  assert.notEqual(first.key,second.key);
  assert.equal(newAlertKeys({alerts:[first,second]},{[first.key]:'sent',SOXL:'legacy'}).length,1);
  assert.equal(newAlertKeys({alerts:[first]},{[second.key]:'sent'}).length,0);
  const t=evaluateSleeves({H:100,price:50},null,10000,true)[0];
  assert.equal(t.trigger50,50); assert.equal(t.status,'confirmed');
});
