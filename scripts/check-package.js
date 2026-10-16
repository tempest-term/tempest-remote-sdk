'use strict';
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const temp = mkdtempSync(path.join(tmpdir(), 'tempest-sdk-'));
function npm(args, cwd) {
  return execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
}
try {
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', temp], root));
  for (const file of ['src/index.js', 'src/index.d.ts', 'LICENSE', 'README.md']) {
    assert.ok(packed.files.some(entry => entry.path === file), `Missing ${file}`);
  }
  writeFileSync(path.join(temp, 'package.json'), '{"private":true}');
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed.filename)], temp);
  execFileSync(process.execPath, ['-e', "if(typeof require('@tempest-term/remote-sdk').ControlClient !== 'function') process.exit(1)"], { cwd: temp });
  execFileSync(process.execPath, ['--input-type=module', '-e', "import { ControlClient } from '@tempest-term/remote-sdk'; if(typeof ControlClient !== 'function') process.exit(1)"], { cwd: temp });
  writeFileSync(path.join(temp, 'consumer.ts'), `
import { ControlClient, Prompt, PromptAnswer, Remote, Server } from '@tempest-term/remote-sdk';
const prompt = async (p: Prompt): Promise<PromptAnswer> => p.kind === 'confirm' ? false : undefined;
const c = new ControlClient('tempest', prompt, { account: 'test', timeoutMs: 1000 });
const servers: Promise<Server[]> = c.listServers();
const remote: Promise<Remote> = c.ensureRemote('opaque', { configFile: '/tmp/ssh-config' });
c.dispose();
`);
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--target', 'es2022', '--module', 'node16', '--moduleResolution', 'node16', 'consumer.ts'],
  { cwd: temp, stdio: 'inherit' });
  console.log('Packed package: CommonJS, ESM, and TypeScript consumers passed.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
