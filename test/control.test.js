'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ControlClient } = require('../src');

function harness(prompt) {
  const client = Object.create(ControlClient.prototype);
  Object.assign(client, { pending: new Map(), closed: false, prompt,
    promptQueue: Promise.resolve(), sent: [] });
  client.send = message => client.sent.push(message);
  return client;
}

test('prompt cancellation is explicit and never an empty password', async () => {
  const client = harness(async () => undefined);
  client.receive({ type: 'prompt', id: 'p1', kind: 'password', message: 'Password' });
  await client.promptQueue;
  assert.deepEqual(client.sent, [{ type: 'prompt_response', id: 'p1', cancelled: true }]);
});

test('sequential prompts preserve ids and empty input', async () => {
  const client = harness(async prompt => prompt.id === 'p1' ? '' : '123456');
  client.receive({ type: 'prompt', id: 'p1', kind: 'password', message: 'Passphrase' });
  client.receive({ type: 'prompt', id: 'p2', kind: 'text', message: 'OTP' });
  await client.promptQueue;
  assert.deepEqual(client.sent.map(message => [message.id, message.value]), [['p1', ''], ['p2', '123456']]);
});

test('response correlation does not settle another request', () => {
  const client = harness();
  let resolved;
  client.pending.set('2', { resolve: value => { resolved = value; }, reject: assert.fail });
  client.receive({ type: 'response', id: '1', result: 'unrelated' });
  assert.equal(resolved, undefined);
  client.receive({ type: 'response', id: '2', result: { protocol: 1 } });
  assert.deepEqual(resolved, { protocol: 1 });
  assert.equal(client.pending.size, 0);
});

test('remote error details containing secrets are not surfaced', () => {
  const client = harness();
  let error;
  client.pending.set('1', { resolve: assert.fail, reject: value => { error = value; } });
  client.receive({ type: 'response', id: '1', error: { message: 'password=secret' } });
  assert.ok(error instanceof Error);
  assert.equal(error.message.includes('secret'), false);
});

test('reject unknown prompt kinds', () => {
  assert.throws(() => harness().receive({ type: 'prompt', id: 'p1', kind: 'execute', message: 'Run code' }));
});

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
function processClient(options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => { child.killed = true; };
  child.unref = () => { child.unreferenced = true; };
  let invocation;
  const client = new ControlClient('/path with spaces/tempest', async () => 'otp', {
    spawnProcess: (...args) => { invocation = args; return child; }, ...options,
  });
  return { client, child, invocation };
}

test('launch uses argument array without shell and fragmented frames decode correctly', async () => {
  const { client, child, invocation } = processClient();
  assert.equal(invocation[0], '/path with spaces/tempest');
  assert.deepEqual(invocation[1], ['remote', 'control', '--protocol', '1']);
  assert.equal(invocation[2].shell, false);
  const answer = client.request('capabilities');
  child.stdout.write('{"type":"response","id":"1",');
  child.stdout.write('"result":{"protocol":1}}\n');
  assert.deepEqual(await answer, { protocol: 1 });
  client.dispose();
  assert.equal(child.killed, true);
});

test('ready remote is detached on dispose, not killed', async () => {
  const { client, child } = processClient();
  const answer = client.request('remote.ensure');
  child.stdout.write('{"type":"response","id":"1","result":{"sshHost":"tempest-a"}}\n');
  await answer;
  client.dispose();
  assert.equal(child.killed, undefined);
  assert.equal(child.unreferenced, true);
  assert.equal(child.stdin.writableEnded, true);
});

test('oversized frame rejects pending work and terminates unready control process', async () => {
  const { client, child } = processClient({ maxFrameBytes: 65536 });
  const answer = client.request('capabilities');
  child.stdout.write('x'.repeat(65537));
  await assert.rejects(answer, /Oversized/);
  assert.equal(child.killed, true);
});

test('cancelled authentication is distinguished from a connection failure', async () => {
  const { client, child } = processClient();
  const answer = client.request('remote.ensure');
  child.stdout.write('{"type":"response","id":"1","error":{"code":"cancelled"}}\n');
  await assert.rejects(answer, error => error.name === 'CancellationError');
  client.dispose();
});

test('known account errors have actionable messages without reflecting CLI diagnostics', () => {
  const client = harness();
  let error;
  client.pending.set('1', { resolve: assert.fail, reject: value => { error = value; } });
  client.receive({ type: 'response', id: '1', error: {
    code: 'vault_unavailable', message: 'sensitive transport diagnostic',
  } });
  assert.match(error.message, /Unlock it in Tempest/);
  assert.equal(error.message.includes('sensitive'), false);
});


test('notification cancellation rejects pending work and stops the CLI', async () => {
  const { client, child } = processClient();
  const pending = client.request('remote.ensure');
  client.cancel();
  await assert.rejects(pending, error => error.name === 'CancellationError');
  assert.equal(child.killed, true);
});

test('large server lists and split multibyte UTF-8 frames are accepted', async () => {
  const { client, child } = processClient();
  const servers = Array.from({ length: 3000 }, (_, i) => ({ id: String(i), label: '服务器' }));
  const bytes = Buffer.from(JSON.stringify({ type: 'response', id: '1', result: servers }) + '\n');
  assert.ok(bytes.length > 65536);
  const pending = client.request('servers.list');
  for (let i = 0; i < bytes.length; i += 997) child.stdout.write(bytes.subarray(i, i + 997));
  assert.deepEqual(await pending, servers);
  client.dispose();
});

test('oversized outgoing requests reject without leaving pending timers', async () => {
  const { client, child } = processClient();
  await assert.rejects(client.request('remote.ensure', { serverId: 'x'.repeat(65536) }), /Cannot send/);
  assert.equal(client.pending.size, 0);
  assert.equal(child.killed, true);
});

test('process exit rejects pending requests', async () => {
  const { client, child } = processClient();
  const pending = client.request('capabilities');
  child.emit('exit', 1);
  await assert.rejects(pending, /control exited/);
});

test('malformed responses reject pending requests without reflecting their content', async () => {
  const { client, child } = processClient();
  const pending = client.request('capabilities');
  child.stdout.write('password=secret\n');
  await assert.rejects(pending, error => /Invalid/.test(error.message) && !error.message.includes('secret'));
});

test('finite request timeout terminates setup and rejects pending work', async () => {
  const { client, child } = processClient({ timeoutMs: 5 });
  await assert.rejects(client.request('capabilities'), /timed out/);
  assert.equal(child.killed, true);
});

function respond(child, results) {
  child.stdin.on('data', data => {
    const request = JSON.parse(data);
    child.stdout.write(JSON.stringify({ type: 'response', id: request.id, result: results.shift() }) + '\n');
  });
}

test('typed convenience methods validate protocol, list and remote identity', async () => {
  const { client, child } = processClient();
  const servers = [{ id: 'opaque', label: 'Host' }];
  const remote = { sshHost: `tempest-${'a'.repeat(64)}`, sessionId: 'b'.repeat(64) };
  respond(child, [{ protocol: 1 }, servers, { protocol: 1 }, remote]);
  assert.deepEqual(await client.listServers(), servers);
  assert.deepEqual(await client.ensureRemote(servers[0].id), remote);
  client.dispose();
  assert.equal(child.killed, undefined);
});

test('incompatible protocol and malformed server lists are rejected', async () => {
  for (const results of [[{ protocol: 2 }], [{ protocol: 1 }, [{ label: 'Missing id' }]]]) {
    const { client, child } = processClient();
    respond(child, results);
    await assert.rejects(client.listServers(), /protocol v1|Invalid server list/);
    client.dispose();
    assert.equal(child.killed, true);
  }
});

test('invalid remote identity cancels setup rather than handing it off', async () => {
  const { client, child } = processClient();
  respond(child, [{ protocol: 1 }, { sshHost: 'bad', sessionId: 'bad' }]);
  await assert.rejects(client.ensureRemote('opaque'), /Invalid remote/);
  assert.equal(child.killed, true);
});

test('unknown error codes cannot select prototype properties or leak diagnostics', () => {
  const client = harness();
  let error;
  client.pending.set('1', { resolve: assert.fail, reject: value => { error = value; } });
  client.receive({ type: 'response', id: '1', error: { code: 'constructor', message: 'secret' } });
  assert.equal(error.code, 'remote_failed');
  assert.equal(error.message.includes('secret'), false);
});
