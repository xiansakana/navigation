import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import notifier from 'node-notifier';
import { sendEmail } from './email.js';

test('notification dependencies load and email sends through a local SMTP transport', { timeout: 10000 }, async t => {
  assert.equal(typeof notifier.notify, 'function');
  const messages = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 localhost test SMTP\r\n');
    let buffer = '', data = null;
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const offset = buffer.indexOf('\r\n'), line = buffer.slice(0, offset);
        buffer = buffer.slice(offset + 2);
        if (data !== null) {
          if (line === '.') { messages.push(data.join('\r\n')); data = null; socket.write('250 queued locally\r\n'); }
          else data.push(line);
        } else if (/^EHLO|^HELO/.test(line)) socket.write('250 localhost\r\n');
        else if (line === 'DATA') { data = []; socket.write('354 End with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = await sendEmail({ smtp: { host: '127.0.0.1', port: server.address().port, secure: false },
    from: 'sender@example.invalid', to: 'recipient@example.invalid' }, 'Local transport regression', { subject: 'Local SMTP test' });
  assert.deepEqual(result.accepted, ['recipient@example.invalid']);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Subject: Local SMTP test/);
  assert.match(messages[0], /Local transport regression/);
});
