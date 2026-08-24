'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const created = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

// An ephemeral port, so the suite never collides with the user's running
// instance on 4177 — and never writes into their real ~/.skillspace either.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// The bind is a property of the socket, not of any response body, and the
// server under test is a child process - so server.address() is unavailable and
// reachability is the only observable. These helpers spawn extra short-lived
// servers for that purpose; the suite's main server is left alone.
function externalIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

// probeHost must name an address the spawned variant actually binds - probing
// 127.0.0.1 against a HOST=::1 server just times out and reports "did not
// start" for a server that started perfectly well.
async function spawnServer(env, probeHost = '127.0.0.1') {
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), SKILLSPACE_HOME: tmp('skillspace-bind-'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try { if ((await fetch(`http://${probeHost}:${port}/api/config`)).ok) break; } catch (_) {}
    if (Date.now() > deadline) { proc.kill('SIGKILL'); throw new Error('server did not start'); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child: proc, port };
}

function reachable(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(3000);
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
}

let child, base, storeRoot;

before(async () => {
  const port = await freePort();
  storeRoot = tmp('skillspace-apihome-');
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), SKILLSPACE_HOME: storeRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  // Poll until it answers rather than sleeping a fixed interval.
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server exited early: ' + stderr);
    try {
      const r = await fetch(base + '/api/config');
      if (r.ok) break;
    } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start: ' + stderr);
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  if (child) child.kill('SIGKILL');
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

const json = async (method, p, body) => {
  const r = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

test('GET /api/projects is an empty array before anything exists', async () => {
  const r = await json('GET', '/api/projects');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.projects, []);
});

test('POST /api/projects creates a project and GET lists it', async () => {
  const dir = tmp('skillspace-apiwork-');
  const c = await json('POST', '/api/projects', { name: 'API', path: dir });
  assert.strictEqual(c.status, 200);
  assert.ok(c.body.project.id);
  assert.strictEqual(c.body.project.name, 'API');
  assert.strictEqual(c.body.project.kind, 'dir');
  assert.strictEqual(c.body.project.concurrency, 1);

  const l = await json('GET', '/api/projects');
  assert.strictEqual(l.body.projects.length, 1);
  assert.strictEqual(l.body.projects[0].id, c.body.project.id);
});

test('POST rejects a path that does not exist with 400, not 500', async () => {
  const r = await json('POST', '/api/projects', { name: 'Nope', path: '/definitely/not/here' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /path does not exist/);
});

test('POST with no body is a 400, not a crash', async () => {
  const r = await json('POST', '/api/projects', {});
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.error);
});

test('POST cannot dictate kind — a plain dir stays dir over HTTP', async () => {
  const dir = tmp('skillspace-apiwork-');
  const r = await json('POST', '/api/projects', { path: dir, kind: 'git', concurrency: 8 });
  assert.strictEqual(r.body.project.kind, 'dir');
  assert.strictEqual(r.body.project.concurrency, 1);
});

test('DELETE removes the record, keeps the files, and says so', async () => {
  const dir = tmp('skillspace-apiwork-');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'precious');
  const c = await json('POST', '/api/projects', { name: 'Safe', path: dir });

  const d = await json('DELETE', '/api/projects/' + c.body.project.id);
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.body.filesKept, true);

  // the non-destructive contract is the point of this route
  assert.ok(fs.existsSync(path.join(dir, 'keep.txt')));
  assert.ok(fs.existsSync(dir));
});

test('DELETE of an unknown id is a 404, not a false success', async () => {
  const r = await json('DELETE', '/api/projects/prj-does-not-exist');
  assert.strictEqual(r.status, 404);
});

test('DELETE rejects an id that is not a plain identifier', async () => {
  // These reach the handler intact - new URL() leaves percent-escapes encoded -
  // so the route itself is what rejects them. Asserting 400 exactly, because
  // "400 or 404" also passes against a route that does not exist at all, which
  // is how this test passed vacuously before the handler was written.
  for (const bad of ['a%2Fb', '%ZZ']) {
    const r = await fetch(base + '/api/projects/' + bad, { method: 'DELETE' });
    assert.strictEqual(r.status, 400, `id ${JSON.stringify(bad)} got ${r.status}`);
  }

  // Dot-segments never get that far: new URL() resolves them before the handler
  // sees a pathname, so "/api/projects/.." arrives as "/api/" and
  // "/api/projects/../projects" as "/api/projects", neither of which this route
  // matches. They 404 from the catch-all rather than 400. The property worth
  // pinning is that they are never ACCEPTED, so assert what must never happen.
  for (const bad of ['..', '../projects', '']) {
    const r = await fetch(base + '/api/projects/' + bad, { method: 'DELETE' });
    assert.notStrictEqual(r.status, 200, `id ${JSON.stringify(bad)} was accepted`);
    assert.strictEqual(r.status, 404, `id ${JSON.stringify(bad)} got ${r.status}`);
  }

  // and nothing outside the store was touched
  assert.ok(fs.existsSync(storeRoot));
});

test('a nested path is not claimed by the project DELETE route', async () => {
  const r = await fetch(base + '/api/projects/prj-abc/goals/g-1', { method: 'DELETE' });
  // not this route's business - it must fall through, not answer "invalid id"
  assert.strictEqual(r.status, 404);
  const txt = await r.text();
  assert.ok(!txt.includes('invalid project id'), 'nested route was swallowed');
});

test('an oversized body is rejected, not persisted', async () => {
  const dir = tmp('skillspace-apiwork-');
  const r = await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024), path: dir }),
  });
  assert.strictEqual(r.status, 413);
  const l = await json('GET', '/api/projects');
  assert.ok(!l.body.projects.some((p) => p.name.length > 1024), 'oversized record was persisted');
});

test('the oversize sentinel cannot be forged by a caller', async () => {
  // A string sentinel would make this 22-byte body a spurious 413. The Symbol
  // used instead cannot arrive through JSON.parse.
  const dir = tmp('skillspace-apiwork-');
  const r = await json('POST', '/api/projects', { name: 'Forged', path: dir, __oversize: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.project.name, 'Forged');
});

test('an oversized body does not create a defaulted expert', async () => {
  // NOTE: /api/experts persists to <repo>/experts.json via __dirname - it does
  // NOT honour SKILLSPACE_HOME - so before the 413 below existed, every run of
  // this suite wrote a junk expert into the developer's real (gitignored) file.
  const before = await json('GET', '/api/experts');
  const r = await fetch(base + '/api/experts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }),
  });
  assert.strictEqual(r.status, 413);
  const after = await json('GET', '/api/experts');
  assert.strictEqual(after.body.experts.length, before.body.experts.length);
});

test('an oversized body does not kill the server', async () => {
  // Resolving null for oversize crashed the process here: an un-updated route
  // reads body.name and throws out of the async handler. Every route must
  // survive an oversize body, whether or not it checks for one.
  const r = await fetch(base + '/api/experts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }),
  });
  assert.ok(r.status < 500, `oversize body to /api/experts got ${r.status}`);
  // still serving afterwards
  const after = await json('GET', '/api/projects');
  assert.strictEqual(after.status, 200);
});

test('records are written under SKILLSPACE_HOME, not the real home directory', async () => {
  const dir = tmp('skillspace-apiwork-');
  await json('POST', '/api/projects', { name: 'Located', path: dir });
  assert.ok(fs.existsSync(path.join(storeRoot, 'projects.json')));
});

test('the server is not reachable from a non-loopback interface by default', async (t) => {
  const lan = externalIPv4();
  // Skipped, never silently passed: with no external interface there is nothing
  // to be exposed ON, so the assertion would be vacuous rather than reassuring.
  if (!lan) return t.skip('no non-loopback IPv4 on this machine - cannot test reachability');

  const a = await spawnServer({});
  try {
    assert.strictEqual(await reachable(lan, a.port), false,
      `default bind must not answer on ${lan} - an unauthenticated agent dispatcher was exposed`);
  } finally { a.child.kill('SIGKILL'); }

  // Positive control: the same probe MUST succeed when the bind is opened up,
  // otherwise the assertion above proves nothing about the bind - a mistyped or
  // unroutable address is "refused" too.
  const b = await spawnServer({ HOST: '0.0.0.0' });
  try {
    assert.strictEqual(await reachable(lan, b.port), true,
      `HOST=0.0.0.0 should answer on ${lan}; if not, the negative test above is vacuous`);
  } finally { b.child.kill('SIGKILL'); }
});

test('HOST overrides the default bind', async () => {
  const { child: proc, port } = await spawnServer({ HOST: '::1' }, '[::1]');
  try {
    const r = await fetch(`http://[::1]:${port}/api/config`);
    assert.ok(r.ok, 'HOST=::1 should bind IPv6 loopback');
    assert.strictEqual(await reachable('127.0.0.1', port), false,
      'binding ::1 should leave IPv4 loopback unbound');
  } finally { proc.kill('SIGKILL'); }
});

test('the body cap is 1 MiB - not tighter, not looser', async () => {
  const dir = tmp('skillspace-apiwork-');
  // Bulk rides in `note`, an unknown key: create() reads an allowlist and never
  // copies it, so the request is a legitimate registration that happens to be
  // large. Padding `name` carries the same status codes today - measured, 900
  // KiB gives 200 and 1.2 MiB gives 413 - so it would pass as written. The
  // reason to prefer `note` is that safeString truncates name at 200 chars, so
  // a name-padded body stores identically whatever the cap does: the signal is
  // gone the moment this test is strengthened to assert on the persisted
  // record, the way "an oversized body is rejected, not persisted" already is.
  const pad = 'x'.repeat(900 * 1024);
  const under = await fetch(base + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Under', path: dir, note: pad }),
  });
  assert.strictEqual(under.status, 200, 'a 900 KiB body is under the cap and must be accepted');

  const over = await fetch(base + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Over', path: dir, note: 'x'.repeat(1200 * 1024) }),
  });
  assert.strictEqual(over.status, 413, 'a 1.2 MiB body is over the cap and must be rejected');
});
