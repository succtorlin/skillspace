'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
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
// The shim lives ONLY in fakeHome/.local/bin, and fakeBin is deliberately NOT
// on PATH. That is the whole point: detection uses CHILD_PATH
// (`$HOME/.local/bin:$PATH`) while the spawn uses whatever env it is handed, so
// a shim reachable through both routes cannot tell the two apart. It was on
// PATH as well, which is exactly why a spawn that ignored CHILD_PATH went
// unnoticed - the agent was found anyway. Put it back on PATH and this suite
// stops being able to observe which path spawned it.
//
// The shim exits 0 instantly unless the prompt names SLOW-AGENT, in which case
// it sleeps — that is how "the route did not wait for the agent" becomes
// observable rather than merely asserted.
let fakeBin, fakeHome;
const SLOW_MARK = 'SLOW-AGENT';
const SLOW_SECONDS = 20;

function rigAgent() {
  fakeBin = tmp('skillspace-bin-');           // kept empty: a decoy that must NOT resolve
  fakeHome = tmp('skillspace-fakehome-');
  // Where Claude Code actually installs, and the only place the shim exists.
  const localBin = path.join(fakeHome, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const shim = path.join(localBin, 'claude');
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
    // fakeBin is empty and stays that way: the ONLY route to the shim is
    // $HOME/.local/bin, which only CHILD_PATH provides.
    PATH: `${fakeBin}:/usr/bin:/bin`,
    SKILLSPACE_HOME: home,
    // EXPERTS_FILE is rooted at __dirname and ignores SKILLSPACE_HOME, so
    // without this the suite rewrites the developer's own experts.json - the
    // last path by which running the tests damaged their install.
    SKILLSPACE_EXPERTS_FILE: path.join(home, 'experts.json'),
    // THE SCHEDULER OFF, for every server this file starts. This file tests the
    // HUMAN door - create, dispatch by id, cancel, refuse - and almost every
    // test here seeds a `queued` order on a real project and then asserts it is
    // still queued. A poll loop dispatching them is not a flake to be waited
    // out, it is the loop doing its job, and the assertions would be racing it
    // rather than testing anything. Demonstrated rather than assumed: with
    // SKILLSPACE_SCHEDULER_INTERVAL_MS=15 this file fails on the navigation
    // guard's own order coming back `running`.
    //
    // The wired scheduler is covered by test/scheduler-api.test.js, which is
    // where the loop is the thing under test.
    SKILLSPACE_SCHEDULER: '0',
  };
}

// Poll an observable instead of sleeping a guessed interval. The fixed sleeps
// these replace assumed 15-40ms per order, which holds on a WARM server and
// not on a cold one: the first order on a fresh process takes ~1.3s, and under
// load four cold orders overlap so no slot frees inside any fixed budget.
// Fails loudly on timeout rather than falling through to a confusing assert.
async function waitFor(what, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Settled = the dispatch is over and its slot is back. Reading the record is
// the only observable the HTTP surface offers for that.
const settled = (id, at) => waitFor(`order ${id} to settle`, async () => {
  const r = await json('GET', '/api/orders/' + id, undefined, at);
  if (r.status !== 200) return false;
  const st = r.body.order.status;
  return st !== 'queued' && st !== 'running' ? st : false;
});

async function startServer(home, extraEnv) {
  const port = await freePort();
  const env = { ...childEnvFor(home), PORT: String(port), ...(extraEnv || {}) };
  // Structural, and checked for EVERY server rather than only the first: the
  // later ones are otherwise safe purely by inheriting fakeHome, and a future
  // test passing its own HOME would fail OPEN in silence. server.js builds its
  // child PATH as `${os.homedir()}/.local/bin:$PATH` with no way to override
  // it, and that is where a real `claude` lives, so HOME is the bit that
  // actually isolates the agent.
  //
  // A test may substitute a DIFFERENT home - the no-agent fixture needs one
  // with no .local/bin - but only ever a directory this rig created. That is
  // the property worth guarding; pinning the exact value also forbade
  // legitimate fixtures, and now that the shim lives under HOME rather than on
  // PATH, hiding the agent is only possible by changing HOME.
  assert.ok(created.includes(env.HOME),
    'a server was started with a HOME the rig does not control');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env,
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
  // POST /api/orders spawns a real, credentialed agent, so a rig that failed
  // open would run the user's own `claude` on their account against a temp
  // directory. Every agent this server can see must be the shim. (The empty
  // set is legitimate - one test starts a server with no agent installed.)
  const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  assert.ok(cfg.agents.every((id) => id === 'claude'),
    `test rig did not isolate the agent: ${JSON.stringify(cfg.agents)}`);

  // AND THE SCHEDULER IS OFF, checked for EVERY server this file starts rather
  // than trusted to the env var arriving. This whole file's fixtures are queued
  // orders it expects to STAY queued, so a loop running underneath would be
  // racing them - and it would fail open, silently, exactly the way a rig that
  // lost its agent isolation would. childEnvFor explains why the switch is set;
  // this is what makes it true.
  const sched = await (await fetch(`http://127.0.0.1:${port}/api/scheduler`)).json();
  assert.strictEqual(sched.scheduler.running, false,
    'the test rig did not disable the scheduler, so every queued fixture below is racing it');

  return { child: proc, port, base: `http://127.0.0.1:${port}`, stdout: () => out };
}

let base, storeRoot;

// The repo's own experts.json, snapshotted before anything runs. EXPERTS_FILE
// is rooted at __dirname rather than SKILLSPACE_HOME, so until it was made
// overridable a suite run rewrote the developer's install.
const REPO_EXPERTS = path.join(__dirname, '..', 'experts.json');
let expertsBefore;

before(async () => {
  expertsBefore = fs.existsSync(REPO_EXPERTS) ? fs.readFileSync(REPO_EXPERTS, 'utf8') : null;
  rigAgent();
  storeRoot = tmp('skillspace-ordershome-');
  // The concurrency bound is raised out of the way here so the tests that are
  // not about it never measure it: several of them fire orders back to back,
  // and a dispatch stays in flight for a few ms after its POST returns. The
  // bound gets its own server, at the real default, below.
  const s = await startServer(storeRoot, { SKILLSPACE_MAX_RUNS: '32' });
  base = s.base;
  // startServer asserts the isolation for every server it starts, this one
  // included. Assert the positive case once here too: the shim must actually
  // be FOUND, or the whole suite would dispatch nothing and still pass.
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.deepStrictEqual(cfg.agents, ['claude'], 'the shim was not detected');
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

async function makeProject(extra, at) {
  const dir = tmp('skillspace-orderwork-');
  const r = await json('POST', '/api/projects', { name: 'Orders', path: dir, ...(extra || {}) }, at);
  assert.strictEqual(r.status, 200, 'project fixture failed: ' + JSON.stringify(r.body));
  return r.body.project;
}

// SIGKILL skips the server's own shutdown handler, so an /api/run child - which
// is detached, and whose only time bound is a setTimeout inside that process -
// is orphaned, and the mkdtemp run directory it was given leaks. SIGTERM lets
// the handler reap and clean up; SIGKILL only if the process will not go.
//
// Measured: this file now leaks zero /tmp/skillspace-run-* per run.
// test/projects-api.test.js still SIGKILLs and still leaks one; left alone
// deliberately, because that file is the unedited safety net for the refactor
// this follow-up belongs to and the leak is cosmetic.
async function stopServer(child, ms = 8000) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + ms;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

// A project on a server other than the shared one. makeProject already takes a
// base; this names the common case so a test reads as "a project over there"
// rather than as an argument-shaped hole.
const makeProjectOn = (at) => makeProject(undefined, at);

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

test("an over-long prompt is the caller's fault, not a server error", async () => {
  // lib/orders throws "prompt is too long (100001 > 100000)" - the phrase is
  // not at the END of the message, so an alternation anchored there matched
  // nothing and every oversize input came back 500: SkillSpace claiming it
  // broke, for an input the user only needs to shorten. The boundary itself
  // was never exercised, which is how the anchor survived.
  // A PROJECT PER PROBE. The accepted order below is still dispatching when the
  // next POST arrives, and an unisolated project now takes one order at a time,
  // so reusing one project would answer 409 (project busy) before the prompt
  // was ever validated - masking the 400 this test exists to pin.
  const at = await json('POST', '/api/orders', {
    projectId: (await makeProject()).id, prompt: 'x'.repeat(100000),
  });
  assert.strictEqual(at.status, 200, 'the limit itself must be accepted');

  const over = await json('POST', '/api/orders', {
    projectId: (await makeProject()).id, prompt: 'x'.repeat(100001),
  });
  assert.strictEqual(over.status, 400, 'an over-long prompt is a 400, not a 500');
  assert.match(over.body.error, /is too long/);

  // acceptance carries the same limit and the same message shape
  const acc = await json('POST', '/api/orders', {
    projectId: (await makeProject()).id, prompt: 'ok', acceptance: 'y'.repeat(100001),
  });
  assert.strictEqual(acc.status, 400);
});

test('POST /api/orders refuses an unrecognised agent instead of substituting', async () => {
  // Silently falling back to AGENTS[0] does not merely surprise: runOrder
  // writes the substituted id onto the order record, so the store ends up
  // asserting the caller asked for an agent they never named.
  const project = await makeProject();
  const r = await json('POST', '/api/orders', {
    projectId: project.id, prompt: 'do a thing', agent: 'totally-bogus',
  });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /totally-bogus/, 'the refusal must name the agent');

  // and the refusal created nothing
  const listed = (await json('GET', `/api/orders?project=${project.id}`)).body.orders;
  assert.deepStrictEqual(listed, [], 'a refused agent still created an order');
});

test('a present but non-string agent is refused, not read as absent', async () => {
  // `typeof body.agent === 'string' ? body.agent : ''` read {"agent": 5} as
  // ABSENT and dispatched AGENTS[0] with a 200, while {"agent":"5"} got a 400 -
  // the same silent substitution this route's refusal exists to prevent, one
  // type away, and runOrder writes the resolved id onto the record. The rule
  // now lives in routes/common.js and is shared with the goals route; the
  // obvious patch (`body.agent || ''`) is only partial, which is why 0 and
  // false are here.
  const project = await makeProject();
  for (const agent of [5, 0, false, true, {}, []]) {
    const r = await json('POST', '/api/orders', { projectId: project.id, prompt: 'x', agent });
    assert.strictEqual(r.status, 400,
      `agent ${JSON.stringify(agent)} was accepted with ${r.status}`);
  }
  assert.deepStrictEqual((await json('GET', `/api/orders?project=${project.id}`)).body.orders, [],
    'a refused agent still created an order');

  // null and '' are ABSENT, deliberately - null is how a JSON client
  // serialises a field it does not have, '' is a cleared form field.
  for (const agent of [null, '']) {
    const ok = await json('POST', '/api/orders', {
      projectId: (await makeProject()).id, prompt: 'x', agent,
    });
    assert.strictEqual(ok.status, 200,
      `agent ${JSON.stringify(agent)} should read as absent: ${JSON.stringify(ok.body)}`);
  }
});

test('POST /api/orders defaults the agent when none is named', async () => {
  const project = await makeProject();
  const r = await json('POST', '/api/orders', { projectId: project.id, prompt: 'no agent named' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  // The rig installs exactly one, so the default is observable on the record
  // once dispatch has claimed it. Poll for the claim rather than guessing how
  // long it takes.
  const after = await waitFor('the dispatch to claim an agent', async () => {
    const o = (await json('GET', '/api/orders/' + r.body.order.id)).body.order;
    return o && o.agent ? o : false;
  });
  assert.strictEqual(after.agent, 'claude');
});

test('POST /api/orders refuses when no agent is installed at all', async () => {
  // Same branch as the unrecognised id, other half: with nothing installed the
  // old code dispatched with agent null and let runOrder mark the order failed,
  // which spent a record to say what the request could have been told.
  const emptyBin = tmp('skillspace-noagent-');
  const home = tmp('skillspace-noagenthome-');
  // HOME as well as PATH: the shim lives in fakeHome/.local/bin and CHILD_PATH
  // prepends $HOME/.local/bin unconditionally, so hiding it means giving this
  // server a home that has no .local/bin at all. Still a rig-created temp dir,
  // which is what startServer's guard actually requires.
  const emptyHome = tmp('skillspace-noagenthome-empty-');
  const s = await startServer(home, { PATH: `${emptyBin}:/usr/bin:/bin`, HOME: emptyHome });
  const cfg = await (await fetch(s.base + '/api/config')).json();
  assert.deepStrictEqual(cfg.agents, [], 'fixture still found an agent');

  const project = await makeProject(undefined, s.base);
  const r = await json('POST', '/api/orders', { projectId: project.id, prompt: 'x' }, s.base);
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.deepStrictEqual((await json('GET', '/api/orders', undefined, s.base)).body.orders, []);
  s.child.kill('SIGKILL');
});

test('the number of simultaneous orders is bounded', async () => {
  // Its own server, at the real default bound, so this measures the bound and
  // not whatever the rest of the file happens to have in flight.
  const home = tmp('skillspace-boundhome-');
  const s = await startServer(home);
  // A slow agent, so the accepted orders are still in flight when the next
  // request arrives - otherwise the bound would never be reached and this
  // would pass against no bound at all.
  // ONE PROJECT PER ORDER. These are plain directories, and an unisolated
  // project now runs one order at a time, so eight orders on one project would
  // measure that serialisation rather than the global bound this test is about.
  const accepted = [];
  const projectIds = [];
  for (let i = 0; i < 8; i++) {
    const project = await makeProject(undefined, s.base);
    projectIds.push(project.id);
    const r = await json('POST', '/api/orders', {
      projectId: project.id, prompt: `${SLOW_MARK} n${i}`,
    }, s.base);
    accepted.push(r.status);
  }
  assert.ok(accepted.includes(429), `no request was refused: ${accepted.join(',')}`);
  assert.ok(accepted.filter((x) => x === 200).length <= 4, 'more orders ran than the bound allows');

  // A refused request must not leave a queued order behind.
  let listed = 0;
  for (const id of projectIds) {
    listed += (await json('GET', `/api/orders?project=${id}`, undefined, s.base)).body.orders.length;
  }
  assert.strictEqual(listed, accepted.filter((x) => x === 200).length,
    'a refused request created an order that will never be dispatched');
  s.child.kill('SIGKILL');
});

test('a completed order releases its slot', async () => {
  // The bound test fires slow orders simultaneously, so it proves the limit is
  // enforced but never that a slot comes back. A leaked slot is worse than no
  // bound at all: after N completed orders the server refuses every further
  // one until it restarts. Needs the DEFAULT bound of 4 - against the main
  // server's raised 32 a leak would take 32 orders to surface.
  const home = tmp('skillspace-slothome-');
  const s = await startServer(home);
  const project = await makeProject(undefined, s.base);
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    // Fast agent (no SLOW_MARK), awaited in sequence, so each finishes before
    // the next POST. 150ms is comfortably longer than the shim's whole life -
    // measured at 15-40ms from spawn to runOrder resolving on a dir project,
    // where worktree cleanup is a no-op.
    const r = await json('POST', '/api/orders', { projectId: project.id, prompt: `seq${i}` }, s.base);
    statuses.push(r.status);
    // Wait for THIS order to settle, which is when its slot goes back. A fixed
    // sleep here assumed a warm server and failed 4 runs in 5 under load,
    // where a cold first dispatch takes ~1.3s.
    if (r.status === 200) await settled(r.body.order.id, s.base);
  }
  assert.deepStrictEqual(statuses, [200, 200, 200, 200, 200, 200],
    `a slot was not released: ${statuses.join(',')}`);
  s.child.kill('SIGKILL');
});

test('a dispatch that rejects is recorded on the order, not just the console', async () => {
  // runOrder rejecting means a bug in dispatch rather than a failed order -
  // dispatch records a failed order itself - so this is the one outcome with
  // no durable trace unless the route writes one.
  //
  // Reaching it from outside takes a real fault, not a stub: orders.countToday
  // runs in runOrder's prologue, BEFORE the try that catches everything else,
  // and it calls readdir. An orders/ directory with write+execute but no READ
  // makes that throw while leaving the store writable enough for markFailed to
  // record the outcome - which is exactly the asymmetry this test needs, since
  // an unwritable store would leave the order queued either way and prove
  // nothing.
  const home = tmp('skillspace-rejecthome-');
  const s = await startServer(home);
  const project = await makeProject(undefined, s.base);

  // One normal order first, so orders/ exists to be chmod-ed, and settled.
  const warm = await json('POST', '/api/orders', { projectId: project.id, prompt: 'warm up' }, s.base);
  await settled(warm.body.order.id, s.base);

  const odir = path.join(home, 'orders');
  fs.chmodSync(odir, 0o300);
  let id;
  try {
    const r = await json('POST', '/api/orders', { projectId: project.id, prompt: 'boom' }, s.base);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    id = r.body.order.id;
    // Pollable even mid-chmod: GET /api/orders/:id reads a KNOWN path, and only
    // readdir needs the read bit this test removed.
    await settled(id, s.base);
  } finally {
    fs.chmodSync(odir, 0o700);
  }

  const after = (await json('GET', '/api/orders/' + id, undefined, s.base)).body.order;
  assert.strictEqual(after.status, 'failed',
    'a rejected dispatch left the order queued forever, with the reason only on the console');
  assert.match(after.error, /^dispatch: /);
  s.child.kill('SIGKILL');
});

test('GET /api/orders lists newest first and filters by project', async () => {
  const a = await makeProject();
  const b = await makeProject();
  // Sequential, not concurrent: this test needs two orders on the SAME project
  // to exercise the filter, and an unisolated project runs one at a time. Wait
  // for each to settle rather than racing the guard.
  const first = (await json('POST', '/api/orders', { projectId: a.id, prompt: 'first' })).body.order;
  await settled(first.id);
  const second = (await json('POST', '/api/orders', { projectId: a.id, prompt: 'second' })).body.order;
  await settled(second.id);
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
  // Cancel is state-changing too, and carries the same guard.
  const seeded = seedOrder(storeRoot, 'queued');
  for (const h of shapes) {
    const res = await rawRequest('POST', '/api/orders', h, body);
    assert.match(res, /^HTTP\/1\.1 403 /,
      `navigation shape ${JSON.stringify(h)} was allowed: ${res.slice(0, 40)}`);

    const cancelRes = await rawRequest('POST', `/api/orders/${seeded}/cancel`, h, '');
    assert.match(cancelRes, /^HTTP\/1\.1 403 /,
      `navigation shape ${JSON.stringify(h)} reached cancel: ${cancelRes.slice(0, 40)}`);
  }
  // and none of those navigations actually cancelled anything
  assert.strictEqual((await json('GET', '/api/orders/' + seeded)).body.order.status, 'queued');
  // The shape the console actually uses must still work.
  const ok = await rawRequest('POST', '/api/orders', {
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
  }, body);
  assert.match(ok, /^HTTP\/1\.1 200 /, `the console's own shape must be served: ${ok.slice(0, 40)}`);
});

// A queued order has no runner handle, so dispatch.cancel cannot reach it.
// Writing the record directly is how that state is held still: a dispatched
// order races to 'running' within a microtask of the POST returning.
//
// `extra` overrides fields - a real projectId, a prompt the shim reacts to -
// which is what makes a QUEUED order that nothing has dispatched reachable at
// all: POST /api/orders creates and dispatches in one step, so there is no
// other way to hold one still for the dispatch route to act on.
function seedOrder(root, status, extra) {
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
    ...(extra || {}),
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

test('POST /api/orders/:id/dispatch runs an order that already exists', async () => {
  // THE APPROVAL GATE. Before this route, the entire order-mutating surface was
  // create-and-dispatch plus cancel - so a queued order could never be run, and
  // the only workaround was to re-POST its prompt, which created a THIRD order
  // with goalId null and left the original queued forever.
  const project = await makeProject();
  const id = seedOrder(storeRoot, 'queued', { projectId: project.id, prompt: 'run me' });

  const r = await json('POST', `/api/orders/${id}/dispatch`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.order.id, id);

  const status = await settled(id);
  assert.strictEqual(status, 'succeeded', 'the dispatched order did not run');
  const after = (await json('GET', '/api/orders/' + id)).body.order;
  assert.strictEqual(after.agent, 'claude', 'the record does not say what ran it');
  assert.ok(after.startedAt, 'the order never started');
});

test('dispatch refuses an order that is not queued', async () => {
  // Re-dispatching a RUNNING order puts two agents on one record - the second
  // overwrites the first's handle in dispatch's map, so cancel() reaches
  // neither - and re-dispatching a settled one runs work already accounted for.
  for (const state of ['running', 'succeeded', 'failed', 'cancelled', 'interrupted']) {
    const id = seedOrder(storeRoot, state);
    const r = await json('POST', `/api/orders/${id}/dispatch`);
    assert.strictEqual(r.status, 409, `dispatching a ${state} order got ${r.status}`);
    assert.match(r.body.error, new RegExp(state));
    // The record comes back with the refusal, so a caller sees WHY rather than
    // having to make a second request to find out.
    assert.strictEqual(r.body.order && r.body.order.status, state);
  }
});

test('dispatch of an unknown order is 404, and of a bad id 400', async () => {
  const missing = await json('POST', '/api/orders/ord-not-a-real-order/dispatch');
  assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
  for (const bad of ['a%2Fb', '%ZZ', 'a.b']) {
    const r = await fetch(`${base}/api/orders/${bad}/dispatch`, { method: 'POST' });
    assert.strictEqual(r.status, 400, `id ${JSON.stringify(bad)} got ${r.status}`);
  }

  // POST ONLY. A GET that spawns a credentialed agent is the shape <img src>
  // reaches, and it is the reason /api/run carries a navigation guard at all -
  // a route that answers any method has that door open by construction, whether
  // or not today's header checks happen to cover it.
  const project = await makeProject();
  const queued = seedOrder(storeRoot, 'queued', { projectId: project.id, prompt: 'GET must not run me' });
  const got = await fetch(`${base}/api/orders/${queued}/dispatch`);
  assert.strictEqual(got.status, 404, `GET on the dispatch route got ${got.status}`);
  assert.strictEqual((await json('GET', '/api/orders/' + queued)).body.order.status, 'queued',
    'a GET dispatched an order');
});

test("dispatch of an order whose project is gone is 409, not a 500", async () => {
  // DELETE /api/projects/:id succeeds with orders still pointing at it, so this
  // is reachable without any corruption. The request named a real order; it is
  // the stored state that cannot be acted on.
  const id = seedOrder(storeRoot, 'queued');   // projectId 'prj-seeded', which exists nowhere
  const r = await json('POST', `/api/orders/${id}/dispatch`);
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /project no longer exists/);
  assert.strictEqual((await json('GET', '/api/orders/' + id)).body.order.status, 'queued',
    'a refused dispatch settled the order');
});

test('POST /api/orders/:id/dispatch refuses a top-level navigation', async () => {
  // It spawns exactly the same credentialed agent the create path does, so it
  // carries exactly the same guard. RAW SOCKET: undici rewrites Sec-Fetch-Mode
  // on its own requests, so a fetch-based version of this passes for the wrong
  // reason.
  const project = await makeProject();
  const id = seedOrder(storeRoot, 'queued', { projectId: project.id, prompt: 'navigated in' });
  const shapes = [
    { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
    { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' },
    { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document' },
  ];
  for (const h of shapes) {
    const res = await rawRequest('POST', `/api/orders/${id}/dispatch`, h, '');
    assert.match(res, /^HTTP\/1\.1 403 /,
      `navigation shape ${JSON.stringify(h)} was allowed: ${res.slice(0, 40)}`);
  }
  // and none of them started anything
  assert.strictEqual((await json('GET', '/api/orders/' + id)).body.order.status, 'queued',
    'a navigation dispatched an order');

  // The shape the console actually uses must still work, or this would pass
  // just as well against a route that refuses everything.
  const ok = await rawRequest('POST', `/api/orders/${id}/dispatch`, {
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
  }, '');
  assert.match(ok, /^HTTP\/1\.1 200 /, `the console's own shape must be served: ${ok.slice(0, 40)}`);
  await settled(id);
});

test('dispatch returns immediately, without waiting for the agent', async () => {
  // runOrder resolves only when the agent EXITS - up to orderTimeoutMs, fifteen
  // minutes by default. The shim sleeps on this prompt, so an awaiting route
  // cannot answer in time and this is about the route, not a fast agent.
  const project = await makeProject();
  const id = seedOrder(storeRoot, 'queued', {
    projectId: project.id, prompt: `${SLOW_MARK} dispatched by id`,
  });
  const t0 = Date.now();
  const r = await json('POST', `/api/orders/${id}/dispatch`);
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(elapsed < 2000,
    `dispatch took ${elapsed}ms - the route waited for the agent (shim sleeps ${SLOW_SECONDS}s)`);
  await json('POST', `/api/orders/${id}/cancel`);
});

test('dispatch is refused at the ceiling, leaving the order queued', async () => {
  // The order already exists, so unlike the create path there is no record to
  // avoid leaving behind - the property is that a refused dispatch leaves it
  // QUEUED, which is the honest state for one that was never started and which
  // a later dispatch can still act on. runOrder enforces the same predicate, so
  // this gate is not the guard; it is what turns the refusal into a 429.
  const home = tmp('skillspace-dispatchceiling-');
  const { child: kid, base: b } = await startServer(home, { SKILLSPACE_MAX_RUNS: '1' });
  try {
    const holder = await makeProjectOn(b);
    const held = await json('POST', '/api/orders', {
      projectId: holder.id, prompt: `${SLOW_MARK} holds the only slot`,
    }, b);
    assert.strictEqual(held.status, 200, JSON.stringify(held.body));
    // Vacuous-pass guard: a 429 below means nothing unless the slot is really
    // held. dispatch claims before its first await, so the claim is already
    // made by the time that POST was answered - read it back to be sure.
    const live = (await json('GET', '/api/orders', undefined, b)).body.orders
      .filter((o) => o.status === 'queued' || o.status === 'running');
    assert.strictEqual(live.length, 1, `the holding order was not in flight: ${live.length}`);

    const other = await makeProjectOn(b);
    const id = seedOrder(home, 'queued', { projectId: other.id, prompt: 'wants in' });
    const r = await json('POST', `/api/orders/${id}/dispatch`, undefined, b);
    assert.strictEqual(r.status, 429, `the dispatch route has its own pool: ${JSON.stringify(r.body)}`);
    assert.strictEqual((await json('GET', '/api/orders/' + id, undefined, b)).body.order.status,
      'queued', 'a refused dispatch did not leave the order queued');
  } finally {
    await stopServer(kid);
  }
});

test('shutting the server down cancels its agents instead of orphaning them', async () => {
  // The timeout that bounds a stuck agent is a setTimeout inside the server
  // process, and agents are spawned detached - their own process group - so
  // they never see a signal sent to the server's. Killing the console without
  // cancelling therefore left credentialed agents reparented to init with no
  // time bound at all, which is the product's core claim inverted.
  const home = tmp('skillspace-shutdownhome-');
  const s = await startServer(home);
  const project = await makeProject(undefined, s.base);

  // A marker that reaches the shim's argv, so the agent is findable by pgrep -
  // the order record carries no pid.
  const mark = `SHUTDOWN-MARK-${process.pid}-${Date.now()}`;
  const alive = () => {
    try { return Number(execSync(`pgrep -f ${mark} | wc -l`).toString().trim()); } catch (_) { return 0; }
  };

  const ord = (await json('POST', '/api/orders', {
    projectId: project.id, prompt: `${SLOW_MARK} ${mark}`,
  }, s.base)).body.order;

  for (let i = 0; i < 50 && alive() === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(alive() > 0, 'the agent never started, so this proves nothing about shutdown');

  s.child.kill('SIGTERM');
  await new Promise((r) => s.child.on('exit', r));
  for (let i = 0; i < 80 && alive() > 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(alive(), 0, 'the agent outlived the server with no time bound');

  // and the record says why it ended, rather than leaving reconcile to guess
  const rec = JSON.parse(fs.readFileSync(path.join(home, 'orders', ord.id + '.json'), 'utf8'));
  assert.strictEqual(rec.status, 'cancelled',
    'the server exited before the cancelled order recorded its outcome');
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

// Last, so every server this file started has had its chance to write.
test("the suite does not touch the developer's own experts.json", async () => {
  // Provoke a write first. Without this the assertion is vacuous: nothing else
  // in this file calls /api/experts, so the repo file would be untouched even
  // with the override removed - which is exactly what a mutation run showed.
  const w = await json('POST', '/api/experts', { name: 'rig-probe', summary: 'written by the suite' });
  assert.strictEqual(w.status, 200, `the write must actually happen: ${JSON.stringify(w.body)}`);
  // and it landed in the per-test store, not the install
  assert.ok(fs.existsSync(path.join(storeRoot, 'experts.json')),
    'the override is set but the server wrote somewhere else');

  const now = fs.existsSync(REPO_EXPERTS) ? fs.readFileSync(REPO_EXPERTS, 'utf8') : null;
  assert.strictEqual(now, expertsBefore,
    'running the tests rewrote the repo experts.json - SKILLSPACE_EXPERTS_FILE is not reaching the server');
});

test('a dispatched agent does not inherit the machine\'s credentials', async () => {
  // The allowlist exists and /api/run uses it; this path silently opted out, so
  // an agent spawned by an order held every AWS, GitHub and npm token in the
  // server's environment. Canaries in the server env, a shim that dumps its own
  // env into the order log, and the log must not contain them.
  const home = tmp('skillspace-canaryhome-');
  const agentHome = tmp('skillspace-canaryagent-');
  const localBin = path.join(agentHome, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const shim = path.join(localBin, 'claude');
  fs.writeFileSync(shim, '#!/bin/sh\nenv\nexit 0\n');
  fs.chmodSync(shim, 0o755);

  const s = await startServer(home, {
    HOME: agentHome,
    AWS_SECRET_ACCESS_KEY: 'AKIA-CANARY',
    GITHUB_TOKEN: 'ghp_CANARY',
  });
  const project = await makeProject(undefined, s.base);
  const r = await json('POST', '/api/orders', { projectId: project.id, prompt: 'x' }, s.base);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await settled(r.body.order.id, s.base);

  const log = fs.readFileSync(path.join(home, 'logs', `${r.body.order.id}.log`), 'utf8');
  // Guard against a vacuous pass: if the shim never ran, the log contains no
  // canary for the trivial reason and both assertions below succeed for free.
  assert.match(log, /PATH=/, 'the shim never dumped its environment');
  assert.ok(!log.includes('AKIA-CANARY'), 'the agent inherited an AWS credential');
  assert.ok(!log.includes('ghp_CANARY'), 'the agent inherited a GitHub token');
  s.child.kill('SIGKILL');
});

test('an agent installed only in ~/.local/bin can actually be dispatched', async () => {
  // Detection uses CHILD_PATH, the spawn did not - so a standard install was
  // detected, accepted, and then failed with ENOENT, leaving a skillspace/<id>
  // branch behind per attempt. The rig now places the shim only under
  // $HOME/.local/bin, so this passes only if the spawn uses CHILD_PATH too.
  const home = tmp('skillspace-localbinhome-');
  const s = await startServer(home);
  const cfg = await (await fetch(s.base + '/api/config')).json();
  assert.deepStrictEqual(cfg.agents, ['claude'], 'fixture did not detect the shim');

  const project = await makeProject(undefined, s.base);
  const r = await json('POST', '/api/orders', { projectId: project.id, prompt: 'x' }, s.base);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const status = await settled(r.body.order.id, s.base);

  assert.strictEqual(status, 'succeeded',
    'an agent /api/config reports as installed could not be spawned');
  const log = fs.readFileSync(path.join(home, 'logs', `${r.body.order.id}.log`), 'utf8');
  assert.ok(!/ENOENT/.test(log), `spawn failed: ${log.slice(0, 200)}`);
  s.child.kill('SIGKILL');
});

test('a second order on an unisolated project is refused without leaving a record', async () => {
  // dispatch enforces the serialisation regardless; the route asks first so the
  // refusal is a 409 rather than a queued order nothing will ever dispatch -
  // there is no scheduler yet to pick one up later.
  const project = await makeProject();
  const first = await json('POST', '/api/orders', {
    projectId: project.id, prompt: `${SLOW_MARK} holds the directory`,
  });
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));

  const second = await json('POST', '/api/orders', { projectId: project.id, prompt: 'wants in' });
  assert.strictEqual(second.status, 409, JSON.stringify(second.body));

  const listed = (await json('GET', `/api/orders?project=${project.id}`)).body.orders;
  assert.strictEqual(listed.length, 1,
    'the refused request left an order that will never be dispatched');

  await json('POST', `/api/orders/${first.body.order.id}/cancel`);
});

test('the process-wide agent ceiling is MAX_CONCURRENT_RUNS, not twice it', async () => {
  // /api/run and /api/orders each capped independently, so the real ceiling
  // was 2x the constant. One registry means one ceiling.
  const { child: kid, base: b2 } = await startServer(
    tmp('skillspace-ceilinghome-'), { SKILLSPACE_MAX_RUNS: '2' }
  );
  try {
    const p1 = await makeProjectOn(b2);
    const p2 = await makeProjectOn(b2);
    const a = await fetch(`${b2}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Mode': 'cors' },
      body: JSON.stringify({ projectId: p1.id, prompt: `${SLOW_MARK} one` }),
    });
    const b = await fetch(`${b2}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Mode': 'cors' },
      body: JSON.stringify({ projectId: p2.id, prompt: `${SLOW_MARK} two` }),
    });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    // Both order slots are now taken - dispatch claims before its first await,
    // so the claim is already made by the time the POST above is answered.
    // /api/run must see the same full pool.
    //
    // The third task is deliberately NOT slow: this is about whether the
    // request is admitted, not about holding a slot. A slow one made the
    // accepted case stream for 20s, by which time the two orders had finished
    // and the vacuous-pass guard below fired instead of the real assertion -
    // the failure was right but said the wrong thing.
    const run = await fetch(`${b2}/api/run?skill=x&task=third agent`, {
      headers: { 'Sec-Fetch-Mode': 'cors' },
    });
    // Read the pool BEFORE draining the response, so a refusal is checked
    // against the moment the request was made. Guards a vacuous pass: a 429
    // means nothing if the two orders had already settled.
    const listed = (await (await fetch(`${b2}/api/orders`)).json()).orders;
    assert.strictEqual(
      listed.filter((o) => o.status === 'queued' || o.status === 'running').length, 2,
      `the two orders were not in flight: ${listed.map((o) => o.status).join(',')}`
    );
    const text = await run.text();
    // strictEqual, not `status === 429 || /too many/.test(text)`. The looser
    // shape is the one that has masked a real guard here before: it passes on
    // any body that happens to contain the phrase, and the status was pinned
    // only by the test below - which is about the opposite direction.
    assert.strictEqual(run.status, 429,
      `/api/run kept its own pool: ${run.status} ${text.slice(0, 80)}`);
  } finally {
    await stopServer(kid);
  }
});

test('an order cannot slip past the ceiling while /api/run holds it', async () => {
  // The other half of the same property, and the half a one-directional fix
  // leaves open: making /api/run count the orders' pool closes the 2x ceiling
  // in one direction only. Gating the orders route on the ORDERS count alone
  // still admitted an order while /api/run held every slot - measured at
  // MAX_RUNS=1, which produced two concurrent agents.
  const { child: kid, base: b3 } = await startServer(
    tmp('skillspace-ceilingrun-'), { SKILLSPACE_MAX_RUNS: '1' }
  );
  try {
    // Occupy the one slot from the /api/run side. The response resolves on
    // headers, so the SSE stream is deliberately left undrained - draining it
    // would wait out the agent and free the slot before the assertion.
    const held = await fetch(`${b3}/api/run?skill=x&task=${SLOW_MARK} holds the only slot`);
    assert.strictEqual(held.status, 200);
    // Guard against a vacuous pass: prove the slot really is held before
    // concluding anything from a refusal on the other route.
    const second = await fetch(`${b3}/api/run?skill=x&task=also wants in`);
    await second.text();
    assert.strictEqual(second.status, 429, '/api/run did not hold the slot it was given');

    const project = await makeProjectOn(b3);
    const r = await json('POST', '/api/orders', {
      projectId: project.id, prompt: 'sneaks past the ceiling',
    }, b3);
    assert.strictEqual(r.status, 429,
      `the orders route could not see /api/run's pool: ${JSON.stringify(r.body)}`);

    // And nothing was persisted: a refusal must not leave a queued order that
    // nothing will ever dispatch.
    const listed = (await json('GET', '/api/orders', undefined, b3)).body.orders;
    assert.strictEqual(listed.length, 0, 'the refused order was recorded anyway');
  } finally {
    await stopServer(kid);
  }
});

test("shutting the server down reaps /api/run's agent, not only its orders", async () => {
  // dispatch.cancelAll() covers the orders; nothing covered /api/run's
  // children, which are spawned detached for the same reason - their own
  // process group - and whose only time bound is a setTimeout inside the dying
  // process. Measured before the fix: server exits 0, agent survives.
  const home = tmp('skillspace-runshutdown-');
  const s = await startServer(home);

  // A marker that reaches the shim's argv, so the agent is findable: /api/run
  // keeps no record at all, so there is no id to look anything up by.
  const mark = `RUN-SHUTDOWN-${process.pid}-${Date.now()}`;
  const alive = () => {
    try { return Number(execSync(`pgrep -f ${mark} | wc -l`).toString().trim()); } catch (_) { return 0; }
  };

  // Headers only - draining the stream would wait out the agent.
  const held = await fetch(`${s.base}/api/run?skill=x&task=${SLOW_MARK} ${mark}`);
  assert.strictEqual(held.status, 200);
  for (let i = 0; i < 50 && alive() === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(alive() > 0, 'the agent never started, so this proves nothing about shutdown');

  s.child.kill('SIGTERM');
  await new Promise((r) => s.child.on('exit', r));
  for (let i = 0; i < 80 && alive() > 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(alive(), 0, 'the agent outlived the server with no time bound');
});

test('a route factory refuses to construct without every dependency it needs', async () => {
  // Destructuring a missing key binds `undefined`, so both factories used to
  // construct happily and fail at the first request that needed the key - in a
  // handler, as a bare TypeError, with no hint that the cause was the wiring.
  // Both carried a comment promising otherwise. This is what makes it true.
  const makeOrderRoutes = require('../routes/orders');
  const makeProjectRoutes = require('../routes/projects');
  const stub = () => {};
  const full = {
    root: storeRoot, sendJson: stub, readBody: stub,
    OVERSIZE: Symbol('o'), ABORTED: Symbol('a'), plainIdFrom: stub,
    isTopLevelNavigation: stub, denyNavigation: stub,
    AGENTS: [], maxConcurrentRuns: 4, childEnv: stub,
  };
  // The wiring is right, so this must still construct - otherwise every
  // assertion below passes for the wrong reason.
  assert.strictEqual(typeof makeOrderRoutes(full), 'function');
  assert.strictEqual(typeof makeProjectRoutes(full), 'function');

  for (const key of Object.keys(full)) {
    const { [key]: _omitted, ...rest } = full;
    assert.throws(
      () => makeOrderRoutes(rest),
      (e) => e instanceof TypeError && e.message.includes(key),
      `omitting ${key} constructed the orders route anyway`
    );
  }

  // Named because it is the one whose absence used to be silent rather than
  // loud: the ceiling gate read `agentsRunning() >= maxConcurrentRuns`, and
  // `n >= undefined` is false, so the bound simply disappeared. The gate now
  // goes through dispatch.atCapacity() and no longer reads it, but the key is
  // still required - a 429 that says "(undefined)" is a wiring fault too.
  const { maxConcurrentRuns: _drop, ...noMax } = full;
  assert.throws(() => makeOrderRoutes(noMax), /missing dependency: maxConcurrentRuns/);

  // routes/projects takes a deliberately smaller set, so a key the orders
  // route needs and it does not must NOT be required of it.
  const { childEnv: _c, AGENTS: _a, ...lean } = full;
  assert.strictEqual(typeof makeProjectRoutes(lean), 'function');

  // The list is now shared with routes/goals.js (routes/common.js), so the two
  // agent-spawning routes cannot drift apart on what they require. Pinned here
  // because a shared list silently narrowed would weaken BOTH boot checks at
  // once, which is worse than the duplication it replaced.
  const makeGoalRoutes = require('../routes/goals');
  const { RUN_ROUTE_REQUIRED } = require('../routes/common');
  assert.deepStrictEqual([...RUN_ROUTE_REQUIRED].sort(), Object.keys(full).sort(),
    'the shared required list and this fixture have drifted apart');
  for (const key of Object.keys(full)) {
    const { [key]: _omitted, ...rest } = full;
    assert.throws(() => makeGoalRoutes(rest), (e) => e instanceof TypeError && e.message.includes(key),
      `omitting ${key} constructed the goals route anyway`);
  }
});

// A project on a GIT repo, over HTTP. makeProject's directory is a bare
// mkdtemp, so kind is detected as 'dir' - and on a dir project the route's
// project-busy guard answers a second dispatch first, with a different message
// and for a different reason. Git is the kind with no interlock above the
// claim, so a 409 there can only have come from the claimed-id check.
async function makeGitProject(at) {
  const dir = tmp('skillspace-ordergit-');
  execSync('git init -q', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'original\n');
  execSync('git add -A', { cwd: dir });
  execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: dir });
  return makeProject({ path: dir }, at);
}

test('dispatching an order twice tells the second caller it was refused', async () => {
  // Both POSTs land inside runOrder's claim window, both read `queued`, and
  // before this the second got a 200 while its dispatch was silently refused
  // by runOrder's own `already dispatched` guard. The order was never run
  // twice; the caller was just told the wrong thing.
  const project = await makeGitProject();
  // Vacuous-pass guard: on a dir project the project-busy guard would answer
  // instead, and this test would pass while pinning the wrong refusal.
  assert.strictEqual(project.kind, 'git', 'the fixture is not a git project');
  // seedOrder, not POST /api/orders: that route creates AND dispatches, so the
  // order would already hold the claim and BOTH of these would be refused.
  const id = seedOrder(storeRoot, 'queued', {
    projectId: project.id, prompt: `${SLOW_MARK} dispatched twice`,
  });

  const [a, b] = await Promise.all([
    json('POST', `/api/orders/${id}/dispatch`),
    json('POST', `/api/orders/${id}/dispatch`),
  ]);
  const codes = [a.status, b.status].sort();
  assert.deepStrictEqual(codes, [200, 409], `both callers got ${codes}`);
  const refused = a.status === 409 ? a : b;
  // /already being dispatched/, not /already/: the looser form is satisfied by
  // `order is already running` from the adjacent STATUS check, which is the gate
  // this test is trying to prove it did NOT reach.
  assert.match(refused.body.error, /already being dispatched/, 'the 409 must say why');

  // The winner holds a slot for SLOW_SECONDS otherwise, and every later test in
  // this file shares this server.
  await json('POST', `/api/orders/${id}/cancel`);
});

test('a double dispatch is refused as already dispatched, not blamed on the ceiling', async () => {
  // ORDERING, not the refusal itself. isClaimed sits BEFORE the project-busy
  // and capacity gates, matching runOrder's own precedence - lib/dispatch.js:
  // "After the duplicate check, so re-dispatching one order still says 'already
  // dispatched' rather than blaming the project." Moved below them, this route
  // answers 429 for an order whose only problem is that it is already running,
  // and the caller retries forever against a ceiling that was never the issue.
  //
  // A GIT project at a ceiling of one is the fixture that can tell the two
  // apart. Git skips the project-busy gate entirely, so capacity is the only
  // rival gate; and `worktree add` is what holds the record at `queued` long
  // enough for the second request to land inside the claim window. On a DIR
  // project this cannot be tested at all - prepare returns with no I/O, so the
  // record reads `running` and the status check answers before isClaimed is
  // ever consulted. That half of the ordering is unpinned; see Known limits.
  const home = tmp('skillspace-claimorder-');
  const { child: kid, base: b } = await startServer(home, { SKILLSPACE_MAX_RUNS: '1' });
  try {
    const project = await makeGitProject(b);
    assert.strictEqual(project.kind, 'git', 'a dir project would answer project-busy first');
    const id = seedOrder(home, 'queued', {
      projectId: project.id, prompt: `${SLOW_MARK} claimed before the ceiling`,
    });

    const [a, c] = await Promise.all([
      json('POST', `/api/orders/${id}/dispatch`, undefined, b),
      json('POST', `/api/orders/${id}/dispatch`, undefined, b),
    ]);
    assert.deepStrictEqual([a.status, c.status].sort(), [200, 409],
      `both callers got ${[a.status, c.status]}`);
    const refused = a.status === 409 ? a : c;
    assert.match(refused.body.error, /already being dispatched/,
      'the second caller was blamed for something other than the duplicate');

    // VACUOUS-PASS GUARD, and the whole point of the ceiling of one: prove the
    // capacity gate really would have fired. A DIFFERENT order on a DIFFERENT
    // project gets the 429 - so the 409 above was a choice of precedence, not
    // an absence of anything to compete with.
    const other = await makeGitProject(b);
    const otherId = seedOrder(home, 'queued', { projectId: other.id, prompt: 'x' });
    const full = await json('POST', `/api/orders/${otherId}/dispatch`, undefined, b);
    assert.strictEqual(full.status, 429,
      `the ceiling was not actually full, so the 409 proved nothing: ${JSON.stringify(full.body)}`);

    await json('POST', `/api/orders/${id}/cancel`, undefined, b);
  } finally {
    await stopServer(kid);
  }
});

// ---------- plan 3, Task 0: what the board needs from the list route ----------

test('GET /api/orders with an empty project= is a 400, not the whole store', async () => {
  // A cleared filter is the obvious way for a client to build this query, and
  // it used to answer with every order of every project. ABSENT still lists
  // everything - that is a different request, and the tests above use it.
  const project = await makeProject();
  (await json('POST', '/api/orders', { projectId: project.id, prompt: 'x' })).body.order;
  for (const q of ['?project=', '?project=%20%20', '?project']) {
    const r = await json('GET', '/api/orders' + q);
    assert.strictEqual(r.status, 400, `${q} answered ${r.status}`);
    assert.match(r.body.error, /project/);
    assert.strictEqual(r.body.orders, undefined, `${q} still returned a list`);
  }
  assert.strictEqual((await json('GET', '/api/orders')).status, 200);
});

test('GET /api/orders marks a claimed order, and only while it is claimed', async () => {
  // An order dispatched by hand or by the loop reads `queued` until
  // `worktree add` finishes. `claimed` is the derivation that tells a board it
  // is already starting. Running orders are claimed too - the claim lasts the
  // whole dispatch - and a settled one is not.
  const project = await makeProject();
  const order = (await json('POST', '/api/orders', { projectId: project.id, prompt: SLOW_MARK })).body.order;
  const row = await waitFor('the order to be listed as claimed', async () => {
    const r = await json('GET', `/api/orders?project=${project.id}`);
    const o = r.body.orders.find((x) => x.id === order.id);
    return o && o.claimed === true ? o : false;
  });
  assert.ok(row.status === 'queued' || row.status === 'running', row.status);
  // Never written to disk: a derivation must not become a stored fact.
  assert.strictEqual((await json('GET', `/api/orders/${order.id}`)).body.order.claimed, undefined,
    'the single-order route carries claimed - is it on the record?');

  await json('POST', `/api/orders/${order.id}/cancel`);
  await settled(order.id);
  await waitFor('the claim to be released', async () => {
    const r = await json('GET', `/api/orders?project=${project.id}`);
    const o = r.body.orders.find((x) => x.id === order.id);
    return o && !('claimed' in o);
  });
});
