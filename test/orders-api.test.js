'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const store = require('../lib/store');
const orders = require('../lib/orders');

const created = [];
const children = [];

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

// POST /api/orders spawns a real, credentialed agent. A suite that let the
// server find the user's actual `claude` would run their agent against a temp
// directory, on their account, with the test's prompt — so the environment is
// rigged so the ONLY discoverable agent is a shim.
//
// Both halves are needed. PATH hides /opt/homebrew and the rest, and HOME is
// overridden because server.js builds its child PATH as
// `${os.homedir()}/.local/bin:$PATH` unconditionally, which is where a real
// `claude` usually lives; os.homedir() reads $HOME on POSIX.
//
// The shim exits 0 instantly unless the prompt names SLOW-AGENT, in which case
// it sleeps — that is how "the route did not wait for the agent" becomes
// observable rather than merely asserted.
let fakeBin, fakeHome;
const SLOW_MARK = 'SLOW-AGENT';
const SLOW_SECONDS = 20;

function rigAgent() {
  fakeBin = tmp('skillspace-bin-');
  fakeHome = tmp('skillspace-fakehome-');
  const shim = path.join(fakeBin, 'claude');
  // agent.buildArgs for claude is (p) => ['-p', p], so the prompt is $2.
  fs.writeFileSync(
    shim,
    `#!/bin/sh\ncase "$2" in\n  *${SLOW_MARK}*) sleep ${SLOW_SECONDS} ;;\nesac\nexit 0\n`
  );
  fs.chmodSync(shim, 0o755);
}

function childEnvFor(home) {
  return {
    ...process.env,
    HOME: fakeHome,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    SKILLSPACE_HOME: home,
  };
}

async function startServer(home) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...childEnvFor(home), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  // Drain both pipes: unread, they fill at 64 KiB and wedge the child. Keeping
  // stderr makes a failure to boot say why instead of "did not start".
  let err = '';
  let out = '';
  proc.stderr.on('data', (c) => (err += c));
  proc.stdout.on('data', (c) => (out += c));
  const deadline = Date.now() + 15000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error('server exited early: ' + err + out);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/config`)).ok) break; } catch (_) {}
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('server did not start: ' + err + out);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child: proc, port, base: `http://127.0.0.1:${port}`, stdout: () => out };
}

let base, storeRoot;

before(async () => {
  rigAgent();
  storeRoot = tmp('skillspace-ordershome-');
  const s = await startServer(storeRoot);
  base = s.base;
  // The rig is load-bearing for every dispatch below: if the shim were not the
  // agent the server found, these tests would spawn the user's real one.
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.deepStrictEqual(cfg.agents, ['claude'], 'test rig did not isolate the agent');
});

after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

const json = async (method, p, body, at) => {
  const r = await fetch((at || base) + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};

async function makeProject(extra) {
  const dir = tmp('skillspace-orderwork-');
  const r = await json('POST', '/api/projects', { name: 'Orders', path: dir, ...(extra || {}) });
  assert.strictEqual(r.status, 200, 'project fixture failed: ' + JSON.stringify(r.body));
  return r.body.project;
}

// undici rewrites Sec-Fetch-Mode on its own requests, so a fetch-based version
// of the navigation test passes for the wrong reason. Raw socket, real bytes.
function rawRequest(method, pathname, extraHeaders, body) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
    let out = '';
    sock.on('data', (d) => (out += d));
    sock.on('error', reject);
    sock.on('end', () => resolve(out));
    sock.on('connect', () => {
      const payload = body === undefined ? '' : body;
      const extra = Object.entries(extraHeaders || {})
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('');
      sock.end(
        `${method} ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\n${extra}` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
        `Connection: close\r\n\r\n${payload}`
      );
    });
  });
}

test('POST /api/orders creates a queued order for a real project', async () => {
  const project = await makeProject();
  const r = await json('POST', '/api/orders', { projectId: project.id, prompt: 'do a thing' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.order && r.body.order.id, 'no order returned');
  assert.strictEqual(r.body.order.status, 'queued');
  assert.strictEqual(r.body.order.projectId, project.id);
});

test('POST /api/orders rejects an unknown project with 404', async () => {
  const r = await json('POST', '/api/orders', { projectId: 'prj-nope', prompt: 'do a thing' });
  assert.strictEqual(r.status, 404, JSON.stringify(r.body));
  assert.match(r.body.error, /no such project/);
});

test('POST /api/orders rejects a missing prompt with 400, not 500', async () => {
  // orders.create throws "<field> is required" for this. Reporting it as 500
  // would blame the server for the caller's omission.
  const project = await makeProject();
  const r = await json('POST', '/api/orders', { projectId: project.id });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /prompt is required/);
});

test('POST /api/orders returns immediately, without waiting for the agent', async () => {
  // dispatch.runOrder resolves only when the agent EXITS — up to the project's
  // orderTimeoutMs, 15 minutes by default. Awaiting it inside the handler
  // would hold the connection open for the whole run. The shim sleeps for
  // SLOW_SECONDS on this prompt, so an awaiting route cannot answer in time
  // and this assertion is about the route, not about a fast agent.
  const project = await makeProject({ budget: { orderTimeoutMs: 900000 } });
  assert.ok(project.budget.orderTimeoutMs >= 900000, 'fixture budget was clamped');

  const t0 = Date.now();
  const r = await json('POST', '/api/orders', {
    projectId: project.id,
    prompt: `run the ${SLOW_MARK} please`,
  });
  const elapsed = Date.now() - t0;

  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.order.status, 'queued');
  assert.ok(
    elapsed < 2000,
    `POST took ${elapsed}ms — the route waited for the agent (shim sleeps ${SLOW_SECONDS}s)`
  );
});

test('GET /api/orders lists newest first and filters by project', async () => {
  const a = await makeProject();
  const b = await makeProject();
  const first = (await json('POST', '/api/orders', { projectId: a.id, prompt: 'first' })).body.order;
  const second = (await json('POST', '/api/orders', { projectId: a.id, prompt: 'second' })).body.order;
  const other = (await json('POST', '/api/orders', { projectId: b.id, prompt: 'other' })).body.order;

  const all = await json('GET', '/api/orders');
  assert.strictEqual(all.status, 200);
  const ids = all.body.orders.map((o) => o.id);
  assert.ok(ids.indexOf(second.id) < ids.indexOf(first.id), 'not newest first');
  assert.ok(ids.includes(other.id));

  const filtered = await json('GET', '/api/orders?project=' + a.id);
  assert.strictEqual(filtered.status, 200);
  const fids = filtered.body.orders.map((o) => o.id);
  assert.ok(fids.includes(first.id) && fids.includes(second.id));
  assert.ok(!fids.includes(other.id), 'filter leaked another project’s order');
  assert.ok(filtered.body.orders.every((o) => o.projectId === a.id));
});

test('GET /api/orders/:id returns one order, 404 for unknown', async () => {
  const project = await makeProject();
  const made = (await json('POST', '/api/orders', { projectId: project.id, prompt: 'one' })).body.order;

  const got = await json('GET', '/api/orders/' + made.id);
  assert.strictEqual(got.status, 200, JSON.stringify(got.body));
  assert.strictEqual(got.body.order.id, made.id);
  assert.strictEqual(got.body.order.prompt, 'one');

  const missing = await json('GET', '/api/orders/ord-does-not-exist');
  assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
});

test('an order id that is not a plain identifier is refused with 400', async () => {
  // Ids reach the store as path segments, so a separator or a bad escape must
  // never get through. new URL() leaves percent-escapes encoded, so these
  // arrive at the handler intact and the route itself is what rejects them.
  // 400 exactly: "400 or 404" would also pass against a route that does not
  // exist at all.
  for (const bad of ['a%2Fb', '%ZZ', 'a.b']) {
    const r = await fetch(base + '/api/orders/' + bad);
    assert.strictEqual(r.status, 400, `id ${JSON.stringify(bad)} got ${r.status}`);
    const c = await fetch(base + '/api/orders/' + bad + '/cancel', { method: 'POST' });
    assert.strictEqual(c.status, 400, `cancel id ${JSON.stringify(bad)} got ${c.status}`);
  }
});

test('POST /api/orders refuses a top-level navigation', async () => {
  // Creating an order spawns a credentialed agent, so it carries the same
  // guard as /api/run: a link clicked in Slack, Mail or an IDE preview arrives
  // as Sec-Fetch-Site: none, which passes the cross-origin check, and must not
  // be enough to start work.
  const project = await makeProject();
  const body = JSON.stringify({ projectId: project.id, prompt: 'navigated in' });
  const shapes = [
    { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
    { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' },
    { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document' },
  ];
  for (const h of shapes) {
    const res = await rawRequest('POST', '/api/orders', h, body);
    assert.match(res, /^HTTP\/1\.1 403 /,
      `navigation shape ${JSON.stringify(h)} was allowed: ${res.slice(0, 40)}`);
  }
  // The shape the console actually uses must still work.
  const ok = await rawRequest('POST', '/api/orders', {
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
  }, body);
  assert.match(ok, /^HTTP\/1\.1 200 /, `the console's own shape must be served: ${ok.slice(0, 40)}`);
});

// A queued order has no runner handle, so dispatch.cancel cannot reach it.
// Writing the record directly is how that state is held still: a dispatched
// order races to 'running' within a microtask of the POST returning.
function seedOrder(root, status) {
  const id = orders.newId();
  store.writeJson(root, `orders/${id}.json`, {
    id,
    projectId: 'prj-seeded',
    goalId: null,
    seq: null,
    title: '',
    prompt: 'seeded',
    acceptance: '',
    agent: null,
    cwd: null,
    status,
    exitCode: null,
    verdict: null,
    error: null,
    supersedes: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  });
  return id;
}

test('POST /api/orders/:id/cancel cancels a queued order', async () => {
  // dispatch.cancel only finds a RUNNING order — it returns false for one that
  // is queued or still preparing its worktree, which is exactly the window a
  // user is most likely to click cancel in. The route must handle it itself.
  const id = seedOrder(storeRoot, 'queued');

  const r = await json('POST', `/api/orders/${id}/cancel`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.order.status, 'cancelled',
    'a queued order was reported cancelled without being cancelled');

  // And it is cancelled on disk, not just in the response.
  const onDisk = await json('GET', '/api/orders/' + id);
  assert.strictEqual(onDisk.body.order.status, 'cancelled');
});

test('cancel of an unknown order is 404, of a settled order is 409', async () => {
  const missing = await json('POST', '/api/orders/ord-not-a-real-order/cancel');
  assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));

  for (const settled of ['succeeded', 'failed', 'cancelled', 'interrupted']) {
    const id = seedOrder(storeRoot, settled);
    const r = await json('POST', `/api/orders/${id}/cancel`);
    assert.strictEqual(r.status, 409, `cancelling a ${settled} order got ${r.status}`);
    assert.match(r.body.error, new RegExp(settled));
  }
});

test('running orders are reconciled to interrupted on boot', async () => {
  // An order still marked running lost its child process when the previous
  // server died. It is never assumed to have succeeded.
  const home = tmp('skillspace-reconcile-');
  const id = seedOrder(home, 'running');

  const s = await startServer(home);
  const r = await json('GET', '/api/orders/' + id, undefined, s.base);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.order.status, 'interrupted',
    'a running order survived a restart still marked running');

  // and on disk, which is what the next boot will read
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'orders', id + '.json'), 'utf8'));
  assert.strictEqual(raw.status, 'interrupted');
  s.child.kill('SIGKILL');
});
