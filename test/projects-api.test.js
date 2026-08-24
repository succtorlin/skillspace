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
  // Drain both pipes: unread, they fill at 64 KiB and wedge the child. Also
  // makes a red bind test say why instead of four words.
  let err = '';
  proc.stderr.on('data', (c) => (err += c));
  proc.stdout.on('data', () => {});
  const deadline = Date.now() + 15000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error('server exited early: ' + err);
    try { if ((await fetch(`http://${probeHost}:${port}/api/config`)).ok) break; } catch (_) {}
    if (Date.now() > deadline) { proc.kill('SIGKILL'); throw new Error('server did not start: ' + err); }
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

  // The real claim: no traversal created a sibling namespace in the store.
  assert.deepStrictEqual(fs.readdirSync(storeRoot).sort(), ['projects.json']);
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
  const before = (await json('GET', '/api/projects')).body.projects.length;
  const r = await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024), path: dir }),
  });
  assert.strictEqual(r.status, 413);
  // Count, not name length: safeString truncates at MAX_NAME (200), so a
  // length threshold here is unfalsifiable - no persisted record can exceed
  // it whether the cap works or not. This assertion is the one that fails if
  // an oversized body ever reaches the store.
  const after = (await json('GET', '/api/projects')).body.projects.length;
  assert.strictEqual(after, before, 'an oversized body created a record');
});

// fetch() gives no control over TCP segmentation, so a raw socket is the only
// way to split a body at a chosen byte and exercise the decode boundary.
function rawPost(pathname, bodyBuf, splitAt) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
    let out = '';
    sock.on('data', (d) => (out += d));
    sock.on('error', reject);
    sock.on('end', () => resolve(out));
    sock.on('connect', () => {
      sock.write(
        `POST ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${bodyBuf.length}\r\n` +
        `Connection: close\r\n\r\n`
      );
      sock.write(bodyBuf.subarray(0, splitAt));
      // Land the remainder in a separate TCP segment.
      setTimeout(() => sock.end(bodyBuf.subarray(splitAt)), 50);
    });
  });
}

// Host is a forbidden header for fetch(), so it has to go on the wire by hand.
function rawGet(pathname, hostHeader) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
    let out = '';
    sock.on('data', (d) => (out += d));
    sock.on('error', reject);
    sock.on('end', () => resolve(out));
    sock.on('connect', () => {
      sock.end(`GET ${pathname} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
  });
}

test('a body split mid-character round-trips intact', async () => {
  const dir = tmp('skillspace-apiwork-');
  const name = '中文项目名';
  const bodyBuf = Buffer.from(JSON.stringify({ name, path: dir }), 'utf8');
  // Cut one byte into the first CJK character, so its 3 bytes straddle two
  // chunks. Decoding each chunk separately yields replacement characters.
  const splitAt = bodyBuf.indexOf(Buffer.from(name, 'utf8')) + 1;
  const res = await rawPost('/api/projects', bodyBuf, splitAt);
  assert.ok(res.includes('200 OK'), `expected 200, got: ${res.slice(0, 80)}`);

  const l = await json('GET', '/api/projects');
  const rec = l.body.projects.find((p) => p.path === fs.realpathSync(dir));
  assert.ok(rec, 'record was not created');
  assert.strictEqual(rec.name, name, 'multibyte name was corrupted in transit');
  assert.ok(!rec.name.includes('\uFFFD'), 'name contains replacement characters');
});

test('a non-object JSON body cannot crash the server', async () => {
  // JSON.parse returns null, numbers, strings and arrays too. "null" is
  // truthy, so the empty-body ternary never fired and body[OVERSIZE]
  // dereferenced null, killing the process with an unhandled TypeError. Four
  // bytes, and with Content-Type: text/plain it is a CORS simple request.
  for (const raw of ['null', '123', '"str"', 'false', '[]', '[1,2]']) {
    const r = await fetch(base + '/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
    });
    assert.strictEqual(r.status, 400, `body ${raw} should be a client error`);
  }
  // the server must still be serving
  assert.strictEqual((await json('GET', '/api/projects')).status, 200);
});

test('a non-object JSON body cannot crash the experts route either', async () => {
  const litter = [];
  try {
    for (const raw of ['null', '123', '"str"', 'false', '{"a":1}', '[1,2]']) {
      const r = await fetch(base + '/api/experts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
      });
      // Record BEFORE asserting: a failing iteration used to abandon the
      // expert it had just created, and red is exactly when the suite gets
      // re-run repeatedly - which is how 78 entries piled up.
      const b = await r.json().catch(() => ({}));
      if (b.expert && b.expert.id) litter.push(b.expert.id);
      assert.ok(r.status < 500, `body ${raw} got ${r.status}`);
    }
  } finally {
  // These bodies coerce to {}, which is legitimate for this route, so each one
  // creates a defaulted expert. This route persists to <repo>/experts.json via
  // __dirname and ignores SKILLSPACE_HOME, so without this cleanup the suite
  // accumulates junk in the developer's real file - 78 entries before it was
  // noticed.
    for (const id of litter) {
      await fetch(base + '/api/experts?id=' + encodeURIComponent(id), { method: 'DELETE' });
    }
  }
  assert.strictEqual((await json('GET', '/api/projects')).status, 200);
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
  assert.strictEqual(r.status, 413, `oversize body to /api/experts got ${r.status}`);
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

  // Bytes, not UTF-16 units. 400k CJK characters are 1.2 MB encoded but only
  // 400k units, so a `.length` cap waves this through at ~3x the stated limit -
  // which matters because this product's own UI is Chinese.
  const cjk = '\u4e2d'.repeat(400 * 1000);
  assert.ok(Buffer.byteLength(cjk, 'utf8') > 1024 * 1024, 'fixture must exceed 1 MiB in bytes');
  assert.ok(cjk.length < 1024 * 1024, 'fixture must be under 1 MiB in UTF-16 units');
  const wide = await fetch(base + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Wide', path: dir, note: cjk }),
  });
  assert.strictEqual(wide.status, 413, 'the cap must count bytes, not UTF-16 units');
});

test('a cross-origin request is refused on every method', async () => {
  const evil = { Origin: 'https://evil.example' };
  const g = await fetch(base + '/api/projects', { headers: evil });
  assert.strictEqual(g.status, 403, 'cross-origin GET must be refused');
  const p1 = await fetch(base + '/api/projects', {
    method: 'POST', headers: { ...evil, 'Content-Type': 'text/plain' }, body: '{}',
  });
  assert.strictEqual(p1.status, 403, 'a CORS simple-request POST must be refused');
  const d = await fetch(base + '/api/projects/prj-whatever', { method: 'DELETE', headers: evil });
  assert.strictEqual(d.status, 403, 'cross-origin DELETE must be refused');
});

test('Sec-Fetch-Site covers the no-Origin case that <img src> produces', async () => {
  // A GET from <img src> or <script src> carries no Origin at all, so this
  // header is the only thing standing in front of /api/run's agent spawn.
  const r = await fetch(base + '/api/run?agent=claude&skill=x', {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.strictEqual(r.status, 403, 'cross-site GET to /api/run must be refused');
});

test('a rebound Host header is refused', async () => {
  // DNS rebinding: an attacker domain resolving to 127.0.0.1 arrives
  // same-origin, so Origin alone would admit it. Raw socket because Host is a
  // forbidden header name - undici silently drops it, which made an earlier
  // version of this test pass against a server that never saw the override.
  // Anchored to the status line, not a substring scan: "403" occurs inside
  // random project UUIDs in about 7% of 200-responses, so includes('403')
  // passed 3 runs in 25 with the Host check removed entirely.
  const res = await rawGet('/api/projects', 'evil.example');
  assert.match(res, /^HTTP\/1\.1 403 /, `an unrecognised Host must be refused, got: ${res.slice(0, 40)}`);
  const ok = await rawGet('/api/projects', '127.0.0.1');
  assert.match(ok, /^HTTP\/1\.1 200 /, `a recognised Host must be served, got: ${ok.slice(0, 40)}`);
});

test('same-origin and header-less clients are still served', async () => {
  const { port } = new URL(base);
  // What the console itself sends.
  const same = await fetch(base + '/api/projects', {
    headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.strictEqual(same.status, 200, 'the console must keep working');
  // What typed navigation sends.
  const nav = await fetch(base + '/api/config', { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.strictEqual(nav.status, 200, 'typed navigation must keep working');
  // What curl and this suite send: nothing.
  assert.strictEqual((await json('GET', '/api/projects')).status, 200);
});

test('a top-level array reaches importExperts instead of being coerced away', async () => {
  // importExperts accepts `[...]` as well as {experts:[...]}, and a bare array
  // is a very plausible shape for the classification results an agent POSTs
  // back. Coercing arrays to {} in readBody made that branch dead code and
  // turned this into a permanent job error.
  const tok = await json('POST', '/api/experts/job', { dir: os.homedir() });
  const token = tok.body.token || (tok.body.job && tok.body.job.token);
  assert.ok(token, `expected a job token, got ${JSON.stringify(tok.body).slice(0, 120)}`);

  const r = await fetch(`${base}/api/experts/import?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ name: '数组专家', skills: [] }]),
  });
  const body = await r.json();
  // The array must at least be RECOGNISED as a payload: the "empty or
  // malformed" rejection is the symptom of it having been coerced to {}.
  assert.ok(
    !(body.error && body.error.includes('格式不对')),
    `a top-level array was coerced away: ${JSON.stringify(body)}`
  );
});

test('HOST=0.0.0.0 actually serves on the LAN address', async (t) => {
  const lan = externalIPv4();
  if (!lan) return t.skip('no non-loopback IPv4 on this machine - cannot test reachability');
  // Binding every interface and then 403ing every request that used one is not
  // a security posture, just a confusing one.
  const { child: proc, port } = await spawnServer({ HOST: '0.0.0.0' });
  try {
    const r = await fetch(`http://${lan}:${port}/api/config`);
    assert.strictEqual(r.status, 200, `HOST=0.0.0.0 must serve on ${lan}, not 403 it`);
  } finally { proc.kill('SIGKILL'); }
});

test('a connection dropped mid-body persists nothing', async () => {
  const before = (await json('GET', '/api/experts')).body.experts.length;
  const { port } = new URL(base);
  // Promise Content-Length we never deliver, then destroy: the route sees an
  // abort, and /api/experts writes on empty input, so resolving {} here left a
  // defaulted record behind.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port: Number(port) }, () => {
        sock.write(
          `POST /api/experts HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Content-Type: application/json\r\nContent-Length: 200\r\n\r\n{"name":"partial"`
        );
        setTimeout(() => { sock.destroy(); resolve(); }, 60);
      });
      sock.on('error', () => resolve());
    });
  }
  await new Promise((r) => setTimeout(r, 300));
  const after = (await json('GET', '/api/experts')).body.experts.length;
  assert.strictEqual(after, before, 'an aborted upload persisted a record');
  // and the server is still healthy
  assert.strictEqual((await json('GET', '/api/projects')).status, 200);
});
