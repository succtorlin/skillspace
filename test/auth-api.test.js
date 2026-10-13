'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { rawFetch, secretFrom, register, HEADER } = require('./helpers/auth');

// The per-boot API secret (lib/auth.js). Every request here that is meant to
// be REFUSED goes through rawFetch or a raw socket, so nothing adds the header
// behind the test's back.

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

// The only discoverable agent is a shim under the fake HOME's .local/bin (see
// test/orders-api.test.js for why HOME is what isolates it). It records its
// whole environment and argv, one file per invocation, so "the agent cannot
// see the secret" is checked against what an agent actually receives.
let fakeHome, dumpDir;
function rigAgent() {
  fakeHome = tmp('skillspace-authhome-');
  dumpDir = tmp('skillspace-authdump-');
  const localBin = path.join(fakeHome, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const shim = path.join(localBin, 'claude');
  fs.writeFileSync(shim,
    `#!/bin/sh\nf="${dumpDir}/run-$$"\nenv > "$f.env"\nfor a in "$@"; do printf '%s\\n' "$a"; done > "$f.argv"\nexit 0\n`);
  fs.chmodSync(shim, 0o755);
}

async function startServer(extraEnv) {
  const port = await freePort();
  const home = tmp('skillspace-authstore-');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      HOME: fakeHome, PATH: '/usr/bin:/bin', TMPDIR: os.tmpdir(),
      SKILLSPACE_HOME: home, SKILLSPACE_EXPERTS_FILE: path.join(home, 'experts.json'),
      SKILLSPACE_SCHEDULER: '0', PORT: String(port), ...(extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let out = '';
  proc.stdout.on('data', (c) => (out += c));
  proc.stderr.on('data', (c) => (out += c));
  const secret = register(port, await secretFrom(proc));
  const base = `http://127.0.0.1:${port}`;
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.deepStrictEqual(cfg.agents, ['claude'], 'the shim must be the only agent');
  return { proc, port, base, secret, home, out: () => out };
}

function raw(port, request) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
    let out = '';
    sock.on('data', (d) => (out += d));
    sock.on('error', reject);
    sock.on('end', () => resolve(out));
    sock.on('connect', () => sock.end(request));
  });
}

const dumps = () => fs.readdirSync(dumpDir);

async function waitFor(what, pred, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function stop(proc) {
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const deadline = Date.now() + 8000;
  while (proc.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

let srv;
before(async () => {
  rigAgent();
  srv = await startServer();
});
after(async () => {
  for (const c of children) await stop(c);
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

test('a non-TTY boot keeps the secret off stdout and writes it to a 0600 console-link file', async () => {
  // launchd sends stdout to a world-readable log (/tmp/skillspace.log, 644),
  // which any agent could cat. Spawned with pipes, stdout is not a TTY.
  assert.match(srv.secret, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(srv.out(), /[0-9a-f]{64}/, 'the secret reached a non-TTY stdout');
  const file = path.join(srv.home, 'console-link');
  assert.ok(srv.out().includes(file), 'stdout names where the link is');
  assert.match(srv.out(), /\?auth=<see console-link file>/);
  const st = fs.statSync(file);
  assert.strictEqual(st.mode & 0o777, 0o600, `mode ${(st.mode & 0o777).toString(8)}`);
  const link = fs.readFileSync(file, 'utf8').trim();
  assert.strictEqual(link, `http://localhost:${srv.port}/?auth=${srv.secret}`);
  // The link in the file is the one that works.
  const r = await rawFetch(`http://127.0.0.1:${srv.port}/?auth=${new URL(link).searchParams.get('auth')}`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.match(r.headers.get('set-cookie') || '', /HttpOnly/);
});

test('the secret differs per boot, and a clean shutdown removes the console-link file', async () => {
  const other = await startServer();
  const file = path.join(other.home, 'console-link');
  assert.notStrictEqual(other.secret, srv.secret, 'per boot, not fixed');
  assert.ok(fs.existsSync(file));
  await stop(other.proc);
  assert.strictEqual(other.proc.exitCode, 0, 'not a clean shutdown');
  assert.ok(!fs.existsSync(file), 'a stale key file outlived the server');
});

test('the lock page points at npm run open', async () => {
  const html = await (await rawFetch(srv.base + '/')).text();
  assert.match(html, /npm run open/);
});

test('every /api/* route refuses a request without the secret', async () => {
  for (const [method, p] of [
    ['GET', '/api/config'], ['GET', '/api/projects'], ['GET', '/api/orders'],
    ['GET', '/api/goals'], ['GET', '/api/scheduler'], ['GET', '/api/experts'],
  ]) {
    const r = await rawFetch(srv.base + p, { method });
    assert.strictEqual(r.status, 401, `${method} ${p} answered ${r.status} without the secret`);
  }
});

test('a header-less local client cannot register a directory or queue work', async () => {
  const dir = tmp('skillspace-authwork-');
  const p = await rawFetch(srv.base + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'pwn', path: dir }),
  });
  assert.strictEqual(p.status, 401);
  const o = await rawFetch(srv.base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'prj-x', prompt: 'rm -rf ~' }),
  });
  assert.strictEqual(o.status, 401);
  const g = await rawFetch(srv.base + '/api/goals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'prj-x', text: 'anything' }),
  });
  assert.strictEqual(g.status, 401);
  // And nothing reached the store.
  const listed = await (await fetch(srv.base + '/api/projects')).json();
  assert.deepStrictEqual(listed.projects, []);
});

test('a wrong secret is refused the same way as none', async () => {
  const r = await rawFetch(srv.base + '/api/projects', { headers: { [HEADER]: 'f'.repeat(64) } });
  assert.strictEqual(r.status, 401);
  const short = await rawFetch(srv.base + '/api/projects', { headers: { [HEADER]: 'abc' } });
  assert.strictEqual(short.status, 401);
});

test('header-less curl "/api/run?skill=x&task=hello" is refused and spawns nothing', async () => {
  const before = dumps().length;
  // Exactly what curl sends: Host, User-Agent, Accept. No Origin, no Sec-Fetch.
  const res = await raw(srv.port,
    `GET /api/run?skill=x&task=hello HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\n` +
    `User-Agent: curl/8.7.1\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
  assert.match(res, /^HTTP\/1\.1 401 /, res.slice(0, 80));
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(dumps().length, before, 'an agent was spawned by an unauthenticated GET');
});

test('the secret as a query parameter admits EventSource-style GETs, never POSTs', async () => {
  const ok = await rawFetch(`${srv.base}/api/projects?auth=${srv.secret}`);
  assert.strictEqual(ok.status, 200);
  const post = await rawFetch(`${srv.base}/api/projects?auth=${srv.secret}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(post.status, 401, 'a secret in a URL must not authorise a write');
});

test('the agent never sees the secret - not in its env, not in its argv', async () => {
  for (const s of [srv, await startServer({ SKILLSPACE_ENV_PASSTHROUGH: '1' })]) {
    const before = new Set(dumps());
    const r = await rawFetch(`${s.base}/api/run?skill=x&task=hello&auth=${s.secret}`);
    assert.strictEqual(r.status, 200);
    await r.text(); // the stream ends when the shim exits
    const mine = await waitFor('the shim to run', () => {
      const fresh = dumps().filter((f) => !before.has(f));
      return fresh.some((f) => f.endsWith('.argv')) && fresh.some((f) => f.endsWith('.env')) ? fresh : null;
    });
    for (const f of mine) {
      const text = fs.readFileSync(path.join(dumpDir, f), 'utf8');
      assert.ok(text.length > 0, f + ' is empty');
      assert.ok(!text.includes(s.secret), `the agent's ${f} contains the API secret`);
    }
    if (s !== srv) await stop(s.proc);
  }
});

test('GET / without the cookie is a lock screen that does not leak the secret', async () => {
  const r = await rawFetch(srv.base + '/');
  assert.strictEqual(r.status, 401);
  const html = await r.text();
  assert.ok(!html.includes(srv.secret), 'the lock screen leaked the secret');
  assert.ok(!html.includes('/app.js'), 'the lock screen must not be the console');
});

test('the printed link sets an HttpOnly SameSite=Strict cookie, and the cookie unlocks the console', async () => {
  const wrong = await rawFetch(`${srv.base}/?auth=${'0'.repeat(64)}`, { redirect: 'manual' });
  assert.strictEqual(wrong.status, 401);
  assert.strictEqual(wrong.headers.get('set-cookie'), null);

  const r = await rawFetch(`${srv.base}/?auth=${srv.secret}`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/', 'the secret must not stay in the address bar');
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, new RegExp(`^skillspace_auth_${srv.port}=${srv.secret};`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const page = await rawFetch(srv.base + '/', { headers: { Cookie: cookie.split(';')[0] } });
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes(`<meta name="skillspace-auth" content="${srv.secret}">`), 'the console needs the secret');
  assert.ok(html.includes('/auth.js'), 'the console loads the fetch wrapper');
  assert.match(page.headers.get('cache-control') || '', /no-store/);
});

test('the console\'s static assets stay public: they carry no secret', async () => {
  for (const p of ['/auth.js', '/app.js', '/pure.js']) {
    const r = await rawFetch(srv.base + p);
    assert.strictEqual(r.status, 200, p);
    assert.ok(!(await r.text()).includes(srv.secret), p);
  }
});

test('a request with no Host header is refused', async () => {
  const res = await raw(srv.port, `GET /api/config HTTP/1.0\r\n${HEADER}: ${srv.secret}\r\n\r\n`);
  assert.match(res, /^HTTP\/1\.1 403 /, res.slice(0, 60));
});

test('the experts import callback is the one exemption: its job token is its credential', async () => {
  // An agent pastes this URL into curl (see buildClassifyPrompt); it was never
  // given the API secret and must not need it. An unknown token is a 404 from
  // the route itself, which proves the request got past the secret check.
  const r = await rawFetch(srv.base + '/api/experts/import?token=nope', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]',
  });
  assert.strictEqual(r.status, 404);
  const job = await rawFetch(srv.base + '/api/experts/job?token=nope');
  assert.strictEqual(job.status, 401, 'only the import callback is exempt');
});

test('SKILLSPACE_ENV_PASSTHROUGH=1 is announced loudly at boot, and only then', async () => {
  const s = await startServer({ SKILLSPACE_ENV_PASSTHROUGH: '1' });
  try {
    await waitFor('the boot banner', () => s.out().includes('?auth='));
    assert.match(s.out(), /WARNING.*SKILLSPACE_ENV_PASSTHROUGH=1/,
      'the hatch that hands agents every token must not be silent');
  } finally { await stop(s.proc); }
  assert.doesNotMatch(srv.out(), /SKILLSPACE_ENV_PASSTHROUGH/);
});
