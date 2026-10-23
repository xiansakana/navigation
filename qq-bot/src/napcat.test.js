import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { sendMessage } from './napcat.js';
import { parseQqMentions, normalizeQqMentions } from '../../shared/integrations/qq-mentions.js';

test('QQ mentions accept mixed separators, deduplicate and keep all/blank compatibility', () => {
  assert.deepEqual(parseQqMentions('12345678,23456789；34567890 12345678\n23456789、34567890;'), ['12345678', '23456789', '34567890']);
  assert.equal(normalizeQqMentions('12345678，23456789\t34567890'), '12345678,23456789,34567890');
  assert.deepEqual(parseQqMentions('12345678; ALL all'), ['all']);
  assert.deepEqual(parseQqMentions(' ，;； \n'), []);
  assert.throws(() => parseQqMentions('12345678,bad'), /QQ 号/);
  assert.throws(() => parseQqMentions('[CQ:at,qq=all]'), /QQ 号/);
  const ids = Array.from({ length: 51 }, (_, i) => String(10000000 + i));
  assert.equal(parseQqMentions(ids.slice(0, 50).join(' ')).length, 50);
  assert.throws(() => parseQqMentions(ids.join(';')), /50/);
});

test('one group delivery produces multiple OneBot mentions in one request', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { baseUrl: 'http://127.0.0.1:' + server.address().port };
  await sendMessage(config, { type: 'group', groupId: '88888888', atUserId: '12345678,23456789；34567890 12345678' }, '提醒 $100');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/send_group_msg');
  assert.deepEqual(requests[0].body.message, [
    ...['12345678', '23456789', '34567890'].map(qq => ({ type: 'at', data: { qq } })),
    { type: 'text', data: { text: ' 提醒 ＄100' } }
  ]);
  await sendMessage(config, { type: 'group', groupId: '88888888', atUserId: 'all;12345678' }, 'all');
  assert.deepEqual(requests[1].body.message[0], { type: 'at', data: { qq: 'all' } });
  assert.equal(requests[1].body.message.length, 2);
  await sendMessage(config, { type: 'group', groupId: '88888888', atUserId: ' ; ' }, '普通通知');
  assert.equal(requests[2].body.message, '普通通知');
  await assert.rejects(sendMessage(config, { type: 'group', groupId: '88888888', atUserId: 'bad' }, '无效'), /QQ 号/);
  assert.equal(requests.length, 3);
});
