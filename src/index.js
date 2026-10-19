'use strict';
const { spawn } = require('node:child_process');

function isSshHost(host) {
  return typeof host === 'string' && host.length <= 253 &&
    /^tempest-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(host);
}

// Control-only NDJSON. No SSH bytes, terminal escapes, or stderr parsing.
class ControlClient {
  constructor(executable, prompt, { spawnProcess = spawn, onTrace = () => {}, account,
    timeoutMs = 600000, maxFrameBytes = 8 * 1024 * 1024 } = {}) {
    this.trace = onTrace;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.prompt = prompt;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    this.promptQueue = Promise.resolve();
    this.timeoutMs = timeoutMs;
    const args = account ? ['--account', account] : [];
    args.push('remote', 'control', '--protocol', '1');
    this.child = spawnProcess(executable, args, {
      stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true, detached: true,
    });
    this.trace('CLI control process started.');
    this.child.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end;
      while ((end = this.buffer.indexOf(10)) >= 0) {
        if (end > maxFrameBytes) { this.fail(new Error('Oversized Tempest control frame.')); return; }
        const line = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        try { this.receive(JSON.parse(line.toString('utf8'))); }
        catch { this.fail(new Error('Invalid Tempest remote control response.')); return; }
      }
      if (this.buffer.length > maxFrameBytes) this.fail(new Error('Oversized Tempest control frame.'));
    });
    this.child.stdin.on('error', () => this.fail(new Error('Tempest control pipe closed.')));
    this.child.on('error', () => this.fail(new Error('Cannot launch Tempest CLI. Check its executable path.')));
    this.child.on('exit', () => this.fail(new Error('Tempest remote control exited. A CLI with remote protocol v1 is required.')));
  }
  send(message) {
    if (this.closed) throw new Error('Tempest control connection is closed.');
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > 65536) throw new Error('Tempest control request is too large.');
    this.child.stdin.write(frame);
  }
  request(method, params = {}) {
    this.trace?.(`Request: ${method}`);
    if (this.closed) return Promise.reject(new Error('Tempest control connection is closed.'));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('Tempest remote request timed out.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ type: 'request', id, method, params }); }
      catch { this.fail(new Error('Cannot send Tempest control request.')); }
    });
  }
  receive(message) {
    if (!message || typeof message.id !== 'string') throw new Error('Missing message id');
    if (message.type === 'prompt') {
      if (!['password', 'text', 'confirm', 'select'].includes(message.kind) ||
          typeof message.message !== 'string') throw new Error('Invalid prompt');
      this.promptQueue = this.promptQueue.then(async () => {
        if (this.closed) return;
        const value = await this.prompt(message);
        if (!this.closed) this.send(value === undefined
          ? { type: 'prompt_response', id: message.id, cancelled: true }
          : { type: 'prompt_response', id: message.id, value });
      }).catch(() => this.fail(new Error('Tempest authentication prompt failed.')));
      return;
    }
    if (message.type !== 'response') throw new Error('Unknown message type');
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.trace?.(`Response: ${pending.method} (${message.error ? 'failed' : 'ok'})`);
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    // Do not surface arbitrary CLI errors that may contain credentials.
    if (message.error) {
      const messages = {
        local_state_unavailable: 'Cannot read local Tempest account state.',
        account_unavailable: 'Cannot open the selected Tempest account. Check CLI login and connectivity.',
        vault_unavailable: 'Cannot open the Tempest vault. Unlock it in Tempest and try again.',
        catalog_unavailable: 'Cannot read saved servers from the Tempest vault.',
        vault_scope_changed: 'The selected Tempest vault changed. Select the server again.',
        saved_server_unavailable: 'Cannot resolve the saved server and its credentials from Tempest.',
        upstream_connection_failed: 'Cannot establish the upstream SSH connection. Check network reachability, host-key verification and credentials.',
        forwarding_forbidden: 'This vault policy does not permit TCP forwarding, which Tempest remote requires.',
        remote_key_unavailable: 'Cannot prepare local remote keys. Check file permissions and ssh-keygen availability.',
        ssh_config_unavailable: 'Cannot update the SSH config. Check its path and file permissions.',
      };
      const code = Object.hasOwn(messages, message.error.code) ? message.error.code
        : message.error.code === 'cancelled' ? 'cancelled' : 'remote_failed';
      const error = new Error(Object.hasOwn(messages, code) ? messages[code]
        : 'Tempest remote request failed. Check CLI login, vault access, authentication and forwarding permission.');
      error.code = code;
      if (code === 'cancelled') error.name = 'CancellationError';
      else this.trace?.(`Failure: ${pending.method} [${code}] ${error.message}`);
      pending.reject(error);
    }
    else {
      if (pending.method === 'remote.ensure') this.ready = true;
      pending.resolve(message.result);
    }
  }
  async listServers() {
    await this.checkProtocol();
    const servers = await this.request('servers.list');
    if (!Array.isArray(servers) || !servers.every(server => server &&
      typeof server.id === 'string' && typeof server.label === 'string')) {
      throw new Error('Invalid server list from Tempest CLI.');
    }
    return servers;
  }
  async checkProtocol() {
    const capabilities = await this.request('capabilities');
    if (capabilities?.protocol !== 1) throw new Error('Tempest remote protocol v1 is required.');
  }
  async ensureRemote(serverId, { configFile } = {}) {
    if (typeof serverId !== 'string' || serverId.length === 0 || serverId.length > 4096) {
      throw new Error('Use the complete opaque server ID returned by listServers().');
    }
    await this.checkProtocol();
    const remote = await this.request('remote.ensure', { serverId, ...(configFile ? { configFile } : {}) });
    if (!isSshHost(remote?.sshHost) ||
      !/^[a-f0-9]{64}$/.test(remote?.sessionId || '')) {
      this.cancel();
      throw new Error('Invalid remote SSH host or session identity.');
    }
    return remote;
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child.kill();
    this.child.stdout.destroy();
    this.child.stdin.destroy();
  }
  cancel() {
    const error = new Error('Tempest connection cancelled.');
    error.name = 'CancellationError';
    this.fail(error);
  }
  dispose() {
    if (this.ready && !this.closed && this.pending.size === 0) {
      // The CLI retains the tunnel during handoff; authenticated ProxyCommand
      // pipes drive its lifetime. Closing the last pipe releases the tunnel
      // after a short reconnect grace, rather than leaving an idle daemon.
      this.closed = true;
      this.child.stdin.end();
      this.child.stdout.destroy();
      this.child.unref();
      return;
    }
    this.fail(new Error('Tempest control connection disposed.'));
  }
}
module.exports = { ControlClient, isSshHost };
