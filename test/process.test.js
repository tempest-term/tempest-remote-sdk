'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { ControlClient } = require('../src');
function fixture(prompt) {
  return new ControlClient(process.execPath, prompt, { timeoutMs: 3000,
    spawnProcess: (executable, args, options) => spawn(executable,
      [path.join(__dirname, 'fixtures/control.cjs'), ...args], options),
  });
}
test('real stdio subprocess handles authentication, discovery and handoff', async t => {
  const prompts = [];
  const client = fixture(async prompt => { prompts.push(prompt.kind); return ''; });
  t.after(() => client.dispose());
  const servers = await client.listServers();
  assert.deepEqual(prompts, ['password']);
  assert.equal(servers[0].label, '服务器');
  const remote = await client.ensureRemote(servers[0].id);
  assert.equal(remote.sshHost, `tempest-${'a'.repeat(64)}`);
  client.dispose();
  assert.equal(client.closed, true);
});
test('real stdio subprocess receives explicit prompt cancellation', async t => {
  const client = fixture(async () => undefined);
  t.after(() => client.dispose());
  await assert.rejects(client.listServers(), error => error.name === 'CancellationError'
    && !error.message.includes('must-not-be-reflected'));
});
test('installed Tempest CLI negotiates protocol v1', { skip: !process.env.TEMPEST_TEST_CLI }, async t => {
  const client = new ControlClient(process.env.TEMPEST_TEST_CLI, async () => undefined);
  t.after(() => client.dispose());
  assert.deepEqual(await client.request('capabilities'), { protocol: 1 });
  await assert.rejects(client.request('remote.ensure', { serverId: 'invalid' }), /remote request failed/);
});
