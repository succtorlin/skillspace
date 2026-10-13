'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { secretFrom, register } = require('./helpers/auth');

// What argv each agent CLI actually receives. The prompt is ONE element, but
// the CLI parses its own arguments: a prompt beginning with "-" would be read
// as an option unless the argv ends option parsing first. Shims that record
// their argv, one per agent id, are the only discoverable agents.

const created = [];
const children = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const AGENT_IDS = ['claude', 'codex', 'opencode', 'qodercli'];
let base, dumpDir;

before(async () => {
  const home = tmp('skillspace-argvhome-');
  dumpDir = tmp('skillspace-argvdump-');
  const localBin = path.join(home, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  for (const id of AGENT_IDS) {
    fs.writeFileSync(path.join(localBin, id),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "${dumpDir}/${id}.argv"\nexit 0\n`, { mode: 0o755 });
  }
  const store = tmp('skillspace-argvstore-');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      HOME: home, PATH: '/usr/bin:/bin', TMPDIR: os.tmpdir(), SKILLSPACE_HOME: store,
      SKILLSPACE_EXPERTS_FILE: path.join(store, 'experts.json'), SKILLSPACE_SCHEDULER: '0', PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  proc.stderr.on('data', () => {});
  register(port, await secretFrom(proc));
  proc.stdout.on('data', () => {});
  base = `http://127.0.0.1:${port}`;
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.deepStrictEqual(cfg.agents, AGENT_IDS, 'every shim must be found, and only shims');
});
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

async function argvOf(agent) {
  const r = await fetch(`${base}/api/run?agent=${agent}&skill=x&task=hello`);
  assert.strictEqual(r.status, 200);
  await r.text(); // the stream ends when the shim exits
  // NUL-separated: the prompt itself spans several lines.
  return fs.readFileSync(path.join(dumpDir, agent + '.argv'), 'utf8').split('\0').slice(0, -1);
}

test('claude and codex get "--" before the prompt, so it can never parse as an option', async () => {
  const claude = await argvOf('claude');
  assert.deepStrictEqual(claude.slice(0, 2), ['-p', '--']);
  assert.strictEqual(claude.length, 3, 'the prompt is the one element after "--"');
  const codex = await argvOf('codex');
  assert.deepStrictEqual(codex.slice(0, 2), ['exec', '--']);
  assert.strictEqual(codex.length, 3);
});

test('opencode and qodercli keep their argv; orders.create refusing a leading "-" covers them', async () => {
  // Neither CLI's handling of "--" could be confirmed without running a
  // prompt through it, so their argv is unchanged; test/orders.test.js pins the
  // refusal that keeps an option-shaped prompt from ever reaching them.
  assert.deepStrictEqual((await argvOf('opencode'))[0], 'run');
  assert.deepStrictEqual((await argvOf('qodercli'))[0], '-p');
});
