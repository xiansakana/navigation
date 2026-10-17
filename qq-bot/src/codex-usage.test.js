import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readCodexUsage, formatCodexUsage, isUsageQuery } from './codex-usage.js';
import { executeCodex } from './codex-runner.js';

const snapshot = { rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: {
  primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1792840824 },
  secondary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1792254024 }
} } };

function fakeServer(body, check = () => {}) {
  return (binary, args, options) => {
    check(binary, args, options);
    return spawn(process.execPath, ['--input-type=module', '-e', `
      import readline from 'node:readline';
      import assert from 'node:assert/strict';
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      let initialized = false;
      readline.createInterface({input:process.stdin}).on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          assert.equal(message.params.clientInfo.name, 'qq_codex_usage');
          send({id:1,result:{userAgent:'test'}});
        } else if (message.method === 'initialized') initialized = true;
        else {
          assert.ok(initialized);
          assert.equal(message.method, 'account/rateLimits/read');
          ${body}
        }
      });
    `], options);
  };
}

test('quota queries include natural Chinese and project-independent aliases, but not code requests', () => {
  for (const query of ['额度', '/status', 'usage', '还剩多少周额度和5h额度，啥时候重置', '帮我查询当前额度', '现在额度还有多少？', 'What are my remaining usage limits?']) assert.equal(isUsageQuery(query), true, query);
  for (const query of ['修复额度查询', '实现额度接口', '为什么额度读不到', '查询额度然后修改代码', '检查项目', '重置数据库', '增加用量页面', '优化额度按钮']) assert.equal(isUsageQuery(query), false, query);
});

test('stdio handshake fetches real structured quota using configured binary and proxy', async () => {
  const result = await readCodexUsage({binary:'/private/codex',proxyUrl:'http://127.0.0.1:17890'}, {
    spawnProcess:fakeServer(`process.stderr.write('private diagnostic'); send({method:'account/rateLimits/updated',params:{}}); send({id:2,result:${JSON.stringify(snapshot)}});`, (binary,args,options) => {
      assert.equal(binary,'/private/codex'); assert.deepEqual(args,['app-server']);
      assert.equal(options.shell,false); assert.equal(options.env.HTTPS_PROXY,'http://127.0.0.1:17890');
    })
  });
  assert.deepEqual(result,snapshot);
});

test('quota output uses window lengths, mapping precedence and Beijing reset times', () => {
  const text = formatCodexUsage(snapshot,1792242000000);
  assert.match(text,/5 小时额度：剩余 65%；重置：2026\/10\/18 00:20:24/);
  assert.match(text,/周额度：剩余 95%；重置：2026\/10\/24 19:20:24/);
  assert.doesNotMatch(text,/剩余 1%/);
  assert.match(text,/北京时间/);
});

test('missing windows and null fields are unknown, not zero or invented reset times', () => {
  const text = formatCodexUsage({rateLimits:{primary:{windowDurationMins:10080,usedPercent:null,resetsAt:null}}});
  assert.match(text,/5 小时额度：未提供/); assert.match(text,/周额度：剩余 未知；重置：未提供/);
  assert.doesNotMatch(text,/剩余 100%|1970/);
  assert.match(formatCodexUsage({rateLimits:null}),/服务器未返回/);
  assert.match(formatCodexUsage({rateLimits:{primary:{windowDurationMins:15,usedPercent:12.5,resetsAt:0}}}),/15 分钟额度：剩余 87.5%/);
  const separate = formatCodexUsage({rateLimitsByLimitId:{codex:snapshot.rateLimitsByLimitId.codex,'gpt-reserve':{secondary:{windowDurationMins:10080,usedPercent:99}}}});
  assert.match(separate,/额度池 gpt-reserve：[\s\S]*周额度：剩余 1%/);
});

test('RPC errors, invalid snapshots and early exits never expose raw diagnostics', async () => {
  for (const body of ["send({id:2,error:{message:'SECRET_TOKEN'}})", 'send({id:2,result:{}})', 'process.exit(1)']) {
    await assert.rejects(readCodexUsage({}, {spawnProcess:fakeServer(body)}), error => {
      assert.match(error.message,/额度查询失败/); assert.doesNotMatch(error.message,/SECRET_TOKEN/); return true;
    });
  }
  await assert.rejects(readCodexUsage({binary:'qq-codex-nonexistent-binary'}),/额度查询失败/);
});

test('quota query timeout and cancellation terminate a hanging subprocess', async () => {
  let child;
  const hanging = (binary,args,options) => child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);
  await assert.rejects(readCodexUsage({}, {spawnProcess:hanging,timeout:100}),/超时/);
  assert.equal(child.killed,true);
  const controller = new AbortController();
  const pending = readCodexUsage({}, {spawnProcess:hanging,signal:controller.signal});
  controller.abort(); await assert.rejects(pending,/停止/); assert.equal(child.killed,true);
  await assert.rejects(readCodexUsage({}, {signal:controller.signal}),/停止/);
});

test('usage job bypasses Git, model execution and session updates even for a missing project directory', async () => {
  const controller = new AbortController();
  const config = {binary:'/configured/codex'};
  const result = await executeCodex(config,{project:'missing',prompt:'__usage__'},'existing-session',{
    signal:controller.signal,
    command:async()=>assert.fail('must not invoke model'),
    onSession:()=>assert.fail('must not alter session'),
    readUsage:async(c,options)=>{assert.equal(c,config);assert.equal(options.signal,controller.signal);return snapshot;}
  });
  assert.match(result.result,/剩余 65%/); assert.equal(result.commit,undefined); assert.equal(result.sessionId,undefined);
});
