'use strict';
const readline = require('node:readline');
let waiting;
function response(id, result) {
  const data = Buffer.from(JSON.stringify({ type: 'response', id, result }) + '\n');
  process.stdout.write(data.subarray(0, 13));
  process.stdout.write(data.subarray(13));
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'prompt_response') {
    if (message.cancelled) {
      process.stdout.write(JSON.stringify({ type: 'response', id: waiting,
        error: { code: 'cancelled', message: 'must-not-be-reflected' } }) + '\n');
    } else response(waiting, [{ id: 'opaque-identity', label: '服务器' }]);
    return;
  }
  if (message.method === 'capabilities') response(message.id, { protocol: 1 });
  else if (message.method === 'servers.list') {
    waiting = message.id;
    process.stdout.write(JSON.stringify({ type: 'prompt', id: 'p1', kind: 'password', message: 'Fixture password' }) + '\n');
  } else if (message.method === 'remote.ensure') {
    response(message.id, { sshHost: `tempest-${'a'.repeat(64)}`, sessionId: 'b'.repeat(64) });
  }
});
