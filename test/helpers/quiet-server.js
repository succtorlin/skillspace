'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { secretFrom, register } = require('./auth');

// A server for routes that spawn NOTHING. Unlike the agent-spawning suites it
// needs no shim: HOME is an empty temp dir and PATH is /usr/bin:/bin, so no
// agent can be discovered at all - and that is ASSERTED, not assumed, because
// a quiet server that found the developer's real `claude` would be one typo
// away from running it.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startQuietServer(created) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-quiethome-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-quietstore-'));
  created.push(home, store);
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      TMPDIR: os.tmpdir(),
      SKILLSPACE_HOME: store,
      SKILLSPACE_EXPERTS_FILE: path.join(store, 'experts.json'),
      SKILLSPACE_SCHEDULER: '0',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (c) => (out += c));
  proc.stderr.on('data', (c) => (out += c));
  const base = `http://127.0.0.1:${port}`;
  // The per-boot API secret, from the link the server prints (see ./auth.js).
  register(port, await secretFrom(proc));
  const deadline = Date.now() + 15000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error('quiet server exited early: ' + out);
    try { if ((await fetch(base + '/api/config')).ok) break; } catch (_) {}
    if (Date.now() > deadline) { proc.kill('SIGKILL'); throw new Error('quiet server did not start: ' + out); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const cfg = await (await fetch(base + '/api/config')).json();
  if (!Array.isArray(cfg.agents) || cfg.agents.length !== 0) {
    proc.kill('SIGKILL');
    throw new Error('quiet server discovered an agent: ' + JSON.stringify(cfg.agents));
  }
  return { proc, base, store };
}

async function stopQuietServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const deadline = Date.now() + 8000;
  while (proc.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

module.exports = { startQuietServer, stopQuietServer };
