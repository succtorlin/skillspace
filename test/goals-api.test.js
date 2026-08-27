'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const net = require('net');

const store = require('../lib/store');
const goals = require('../lib/goals');

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

// POST /api/goals spawns a real, credentialed agent — the PM. A suite that let
// the server find the user's actual `claude` would run their agent against a
// temp directory, on their account, with the test's prompt, so the environment
// is rigged so the ONLY discoverable agent is a shim.
//
// Both halves are needed. PATH hides /opt/homebrew and the rest, and HOME is
// overridden because server.js builds its child PATH as
// `${os.homedir()}/.local/bin:$PATH` unconditionally, which is where a real
// `claude` usually lives; os.homedir() reads $HOME on POSIX.
//
// The shim lives ONLY in fakeHome/.local/bin, and fakeBin is deliberately NOT
// on PATH. That is the whole point: detection uses CHILD_PATH
// (`$HOME/.local/bin:$PATH`) while the spawn uses whatever env it is handed, so
// a shim reachable through both routes cannot tell the two apart.
//
// What the shim does is chosen by the PROMPT, which for a PM run is
// pm.buildPrompt's text — and that embeds the goal's own text verbatim. So a
// marker in the goal text is how a test picks the PM's behaviour:
//
//   SLOW-AGENT  sleep, so "the route did not wait for the PM" is observable
//               rather than merely asserted, and so a PM can be caught alive
//   PROSE-PM    answer in prose, so the no-plan path is reachable from HTTP
//   NAP-PM      sleep briefly and then finish, for the one test that needs the
//               store tampered with mid-run
//   otherwise   print a two-order plan
let fakeBin, fakeHome;
const SLOW_MARK = 'SLOW-AGENT';
const PROSE_MARK = 'PROSE-PM';
// A short nap, for the one test that needs the PM to still be running while the
// store is tampered with and then to FINISH. SLOW_SECONDS would make it a
// twenty-second test for no extra signal.
const NAP_MARK = 'NAP-PM';
const SLOW_SECONDS = 20;
const NAP_SECONDS = 3;
// Deliberately bracket-free. pm.arraySpans scans for balanced [...] spans, so
// prose containing a bracket would be a different test than the one intended.
const PROSE = 'I would start by reading the README and then talking to someone.';

const PM_SHIM = `#!/bin/sh
case "$2" in
  *${PROSE_MARK}*) echo "${PROSE}" ; exit 0 ;;
  *${SLOW_MARK}*) sleep ${SLOW_SECONDS} ;;
  *${NAP_MARK}*) sleep ${NAP_SECONDS} ;;
esac
cat <<'JSON'
[{"title":"one","prompt":"do one","acceptance":"one is done"},
 {"title":"two","prompt":"do two","acceptance":"two is done"}]
JSON
exit 0
`;

function rigAgent() {
  fakeBin = tmp('skillspace-bin-');           // kept empty: a decoy that must NOT resolve
  fakeHome = tmp('skillspace-fakehome-');
  // Where Claude Code actually installs, and the only place the shim exists.
  const localBin = path.join(fakeHome, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const shim = path.join(localBin, 'claude');
  // agent.buildArgs for claude is (p) => ['-p', p], so the prompt is $2.
  fs.writeFileSync(shim, PM_SHIM);
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
    // without this the suite rewrites the developer's own experts.json.
    SKILLSPACE_EXPERTS_FILE: path.join(home, 'experts.json'),
  };
}

// Poll an observable instead of sleeping a guessed interval. Fails loudly on
// timeout rather than falling through to a confusing assert.
async function waitFor(what, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function startServer(home, extraEnv) {
  const port = await freePort();
  const env = { ...childEnvFor(home), PORT: String(port), ...(extraEnv || {}) };
  // Structural, and checked for EVERY server rather than only the first: the
  // later ones are otherwise safe purely by inheriting fakeHome, and a future
  // test passing its own HOME would fail OPEN in silence.
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
  // POST /api/goals spawns a real, credentialed agent, so a rig that failed
  // open would run the user's own `claude` on their account against a temp
  // directory. Every agent this server can see must be the shim. (The empty
  // set is legitimate - one test starts a server with no agent installed.)
  const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  assert.ok(cfg.agents.every((id) => id === 'claude'),
    `test rig did not isolate the agent: ${JSON.stringify(cfg.agents)}`);

  return {
    child: proc, port, base: `http://127.0.0.1:${port}`,
    stdout: () => out,
    // Exposed because one test's only observable IS a console line: a rejection
    // from lib/plan leaves no durable trace of its own.
    stderr: () => err,
  };
}

// SIGKILL skips the server's own shutdown handler, so a detached PM - whose
// only time bound is a setTimeout inside that process - is orphaned. SIGTERM
// lets the handler reap; SIGKILL only if the process will not go.
async function stopServer(child, ms = 8000) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + ms;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

let base, storeRoot;

const REPO_EXPERTS = path.join(__dirname, '..', 'experts.json');
let expertsBefore;

before(async () => {
  expertsBefore = fs.existsSync(REPO_EXPERTS) ? fs.readFileSync(REPO_EXPERTS, 'utf8') : null;
  rigAgent();
  storeRoot = tmp('skillspace-goalshome-');
  // The concurrency bound is raised out of the way here so the tests that are
  // not about it never measure it: a PM stays in flight for a while after its
  // POST returns, and one test deliberately leaves a 20s PM running. The bound
  // gets its own servers, at explicit values, below.
  const s = await startServer(storeRoot, { SKILLSPACE_MAX_RUNS: '32' });
  base = s.base;
  // startServer asserts the isolation for every server it starts, this one
  // included. Assert the positive case once here too: the shim must actually
  // be FOUND, or every goal would fail to plan and the suite would still pass.
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.deepStrictEqual(cfg.agents, ['claude'], 'the shim was not detected');
});

after(async () => {
  // SIGTERM first: these servers hold detached PMs whose only time bound is a
  // setTimeout inside them, so SIGKILL here would orphan a sleeping agent.
  for (const c of children) await stopServer(c, 3000);
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
  const dir = tmp('skillspace-goalwork-');
  const r = await json('POST', '/api/projects', { name: 'Goals', path: dir, ...(extra || {}) }, at);
  assert.strictEqual(r.status, 200, 'project fixture failed: ' + JSON.stringify(r.body));
  return r.body.project;
}

// Planning is over when the goal leaves `planning`. Reading the record is the
// only observable the HTTP surface offers for that.
const planned = (id, at) => waitFor(`goal ${id} to finish planning`, async () => {
  const r = await json('GET', '/api/goals/' + id, undefined, at);
  if (r.status !== 200) return false;
  return r.body.goal.status !== 'planning' ? r.body : false;
});

// undici rewrites Sec-Fetch-Mode on its own requests, so a fetch-based version
// of the navigation test passes for the wrong reason. Raw socket, real bytes.
function rawRequest(method, pathname, extraHeaders, body, at) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(at || base);
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

// A goal held still in a state the HTTP surface cannot produce on demand.
// A posted goal races out of `planning` within a second, so the boot
// reconciliation needs the record written directly.
//
// `extra` overrides fields, which is also how a record shape lib/goals would
// never write - a non-array orderIds, an id naming an order that is gone - gets
// in front of the join.
function seedGoal(root, status, extra) {
  const id = goals.newId();
  store.writeJson(root, `goals/${id}.json`, {
    id,
    projectId: 'prj-seeded',
    text: 'seeded',
    status,
    pmAgent: null,
    orderIds: [],
    error: null,
    rawPlan: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    ...(extra || {}),
  });
  return id;
}

test('POST /api/goals decomposes into queued orders', async () => {
  const project = await makeProject();
  const r = await json('POST', '/api/goals', { projectId: project.id, text: 'make it good' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.goal && r.body.goal.id, 'no goal returned');
  assert.strictEqual(r.body.goal.status, 'planning');
  assert.strictEqual(r.body.goal.projectId, project.id);

  const after = await planned(r.body.goal.id);
  assert.strictEqual(after.goal.status, 'running',
    `the goal did not reach running: ${after.goal.error}`);
  assert.strictEqual(after.goal.orderIds.length, 2);
  assert.strictEqual(after.orders.length, 2);
  after.orders.forEach((o, i) => {
    assert.strictEqual(o.status, 'queued', 'nothing dispatches a planned order yet');
    assert.strictEqual(o.goalId, after.goal.id, 'the order lost its back-pointer');
    assert.strictEqual(o.seq, i, 'the orders are not in plan order');
    assert.strictEqual(o.projectId, project.id);
  });
  assert.strictEqual(after.orders[0].prompt, 'do one');
  assert.strictEqual(after.orders[1].prompt, 'do two');
});

test('POST /api/goals records which agent planned it', async () => {
  // The record persists pmAgent, which is the whole reason an unrecognised
  // agent must be refused rather than substituted (below).
  const project = await makeProject();
  const r = await json('POST', '/api/goals', { projectId: project.id, text: 'name the agent' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const after = await planned(r.body.goal.id);
  assert.strictEqual(after.goal.pmAgent, 'claude',
    'the goal does not record the agent that planned it');
});

test('POST /api/goals rejects an unknown project with 404', async () => {
  const r = await json('POST', '/api/goals', { projectId: 'prj-nope', text: 'do a thing' });
  assert.strictEqual(r.status, 404, JSON.stringify(r.body));
  assert.match(r.body.error, /no such project/);
  // and nothing was recorded
  assert.deepStrictEqual((await json('GET', '/api/goals?project=prj-nope')).body.goals, []);
});

test('POST /api/goals rejects a missing text with 400, not 500', async () => {
  // goals.create throws "text is required" for this. Reporting it as 500 would
  // blame the server for the caller's omission.
  const project = await makeProject();
  const r = await json('POST', '/api/goals', { projectId: project.id });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /text is required/);
  assert.deepStrictEqual((await json('GET', `/api/goals?project=${project.id}`)).body.goals, [],
    'a refused request still created a goal');
});

test("an over-long goal text is the caller's fault, not a server error", async () => {
  // lib/goals throws "text is too long (100001 > 100000)" - the phrase is not
  // at the END of the message, so an alternation anchored there matches nothing
  // and every oversize input comes back 500. The orders route had exactly that
  // bug; the boundary is the only thing that catches it.
  const atLimit = await json('POST', '/api/goals', {
    projectId: (await makeProject()).id, text: 'x'.repeat(100000),
  });
  assert.strictEqual(atLimit.status, 200, 'the limit itself must be accepted');

  const over = await json('POST', '/api/goals', {
    projectId: (await makeProject()).id, text: 'x'.repeat(100001),
  });
  assert.strictEqual(over.status, 400, 'an over-long text is a 400, not a 500');
  assert.match(over.body.error, /is too long/);
});

test('an oversize body is refused with 413 before anything is created', async () => {
  // A separate branch from "text is too long": readBody caps the REQUEST at
  // 1 MiB and hands back a sentinel, so this never reaches goals.create and
  // must not be reported as a 400 about the text. Left untested, the branch
  // reads as decoration - and the same branch on /api/projects is the one that
  // used to write a defaulted record before it existed.
  const project = await makeProject();
  const r = await fetch(base + '/api/goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, text: 'x'.repeat(1.2 * 1024 * 1024) }),
  });
  assert.strictEqual(r.status, 413, `a 1.2 MiB body got ${r.status}`);
  assert.deepStrictEqual((await json('GET', `/api/goals?project=${project.id}`)).body.goals, [],
    'an oversize request still created a goal');
});

test('POST /api/goals returns immediately, without waiting for the PM', async () => {
  // plan.decompose resolves only when the PM EXITS - up to the project's
  // orderTimeoutMs, 15 minutes by default. Awaiting it inside the handler would
  // hold the connection open for the whole run. The shim sleeps for
  // SLOW_SECONDS on this goal, so an awaiting route cannot answer in time and
  // this assertion is about the route, not about a fast agent.
  const project = await makeProject({ budget: { orderTimeoutMs: 900000 } });
  assert.ok(project.budget.orderTimeoutMs >= 900000, 'fixture budget was clamped');

  const t0 = Date.now();
  const r = await json('POST', '/api/goals', {
    projectId: project.id,
    text: `please plan the ${SLOW_MARK} work`,
  });
  const elapsed = Date.now() - t0;

  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.goal.status, 'planning');
  assert.ok(
    elapsed < 2000,
    `POST took ${elapsed}ms — the route waited for the PM (shim sleeps ${SLOW_SECONDS}s)`
  );
  // And the goal really is still being planned, rather than having been
  // answered by a PM that finished instantly - which would make the timing
  // assertion above vacuous.
  const still = await json('GET', '/api/goals/' + r.body.goal.id);
  assert.strictEqual(still.body.goal.status, 'planning');
});

test('GET /api/goals lists newest first and filters by project', async () => {
  const a = await makeProject();
  const b = await makeProject();
  // Sequential, not concurrent: these are plain directories, and lib/plan
  // claims an unisolated project for the length of the PM run, so a second
  // goal fired at the same project would fail with "project busy".
  const first = (await json('POST', '/api/goals', { projectId: a.id, text: 'first' })).body.goal;
  await planned(first.id);
  const second = (await json('POST', '/api/goals', { projectId: a.id, text: 'second' })).body.goal;
  await planned(second.id);
  const other = (await json('POST', '/api/goals', { projectId: b.id, text: 'other' })).body.goal;

  const all = await json('GET', '/api/goals');
  assert.strictEqual(all.status, 200);
  const ids = all.body.goals.map((g) => g.id);
  assert.ok(ids.indexOf(second.id) < ids.indexOf(first.id), 'not newest first');
  assert.ok(ids.includes(other.id));

  const filtered = await json('GET', '/api/goals?project=' + a.id);
  assert.strictEqual(filtered.status, 200);
  const fids = filtered.body.goals.map((g) => g.id);
  assert.ok(fids.includes(first.id) && fids.includes(second.id));
  assert.ok(!fids.includes(other.id), 'filter leaked another project’s goal');
  assert.ok(filtered.body.goals.every((g) => g.projectId === a.id));
});

test('GET /api/goals/:id returns the goal and its orders', async () => {
  // Both, in one response: a reader always wants both, and a second round trip
  // would race the goal moving on.
  const project = await makeProject();
  const made = (await json('POST', '/api/goals', { projectId: project.id, text: 'both' })).body.goal;
  const done = await planned(made.id);

  const got = await json('GET', '/api/goals/' + made.id);
  assert.strictEqual(got.status, 200, JSON.stringify(got.body));
  assert.strictEqual(got.body.goal.id, made.id);
  assert.strictEqual(got.body.goal.text, 'both');
  assert.ok(Array.isArray(got.body.orders), 'the orders did not come with the goal');
  assert.strictEqual(got.body.orders.length, done.goal.orderIds.length);
  assert.strictEqual(got.body.orders.length, 2);
  assert.deepStrictEqual(
    got.body.orders.map((o) => o.id), done.goal.orderIds,
    'the orders are not the ones the goal names, in the order it names them'
  );

  const missing = await json('GET', '/api/goals/goal-does-not-exist');
  assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
});

test('a goal id that is not a plain identifier is refused with 400', async () => {
  // Ids reach the store as path segments, so a separator or a bad escape must
  // never get through. new URL() leaves percent-escapes encoded, so these
  // arrive at the handler intact and the route itself is what rejects them.
  // 400 exactly: "400 or 404" would also pass against a route that does not
  // exist at all.
  for (const bad of ['a%2Fb', '%ZZ', 'a.b']) {
    const r = await fetch(base + '/api/goals/' + bad);
    assert.strictEqual(r.status, 400, `id ${JSON.stringify(bad)} got ${r.status}`);
    const body = await r.json();
    assert.strictEqual(body.error, 'invalid goal id',
      `the refusal reads "${body.error}"`);
  }
});

test('a malformed or dangling goal record reads as no orders, not a 500', async () => {
  // lib/goals' own usable() check requires only id and createdAt, so a record
  // that parses with the wrong shape reaches get() intact. The join must treat
  // it the way lib/goals already does - dropped from view, not fatal - because
  // a 500 here would make one bad file unreadable rather than merely empty.
  const notAnArray = seedGoal(storeRoot, 'running', { orderIds: 'nope' });
  const r = await json('GET', '/api/goals/' + notAnArray);
  assert.strictEqual(r.status, 200, `a wrong-shaped orderIds gave ${r.status}: ${JSON.stringify(r.body)}`);
  assert.deepStrictEqual(r.body.orders, []);

  // And an id naming an order that is gone is dropped rather than reported as
  // a null the reader has to filter itself.
  const dangling = seedGoal(storeRoot, 'running', { orderIds: ['ord-was-quarantined'] });
  const d = await json('GET', '/api/goals/' + dangling);
  assert.strictEqual(d.status, 200, JSON.stringify(d.body));
  assert.deepStrictEqual(d.body.orders, [], 'a missing order came back as null');
});

test('POST /api/goals/:id is not a route this module owns', async () => {
  // The single-goal handler is a READ. Answering it for any method would have
  // this module claim a path-and-method pair it does not implement, which is
  // how a later POST /api/goals/:id/cancel ends up shadowed by a 200 that
  // cancelled nothing.
  const project = await makeProject();
  const made = (await json('POST', '/api/goals', { projectId: project.id, text: 'read only' })).body.goal;
  const r = await fetch(base + '/api/goals/' + made.id, { method: 'POST' });
  assert.strictEqual(r.status, 404, `POST to a read-only goal route got ${r.status}`);
});

test('POST /api/goals refuses a top-level navigation', async () => {
  // Planning spawns a credentialed agent, so it carries the same guard as
  // creating an order: a link clicked in Slack, Mail or an IDE preview arrives
  // as Sec-Fetch-Site: none, which passes the cross-origin check, and must not
  // be enough to start work.
  const project = await makeProject();
  const body = JSON.stringify({ projectId: project.id, text: 'navigated in' });
  const shapes = [
    { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
    { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' },
    { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document' },
  ];
  for (const h of shapes) {
    const res = await rawRequest('POST', '/api/goals', h, body);
    assert.match(res, /^HTTP\/1\.1 403 /,
      `navigation shape ${JSON.stringify(h)} was allowed: ${res.slice(0, 40)}`);
  }
  // and none of those navigations started any work
  assert.deepStrictEqual((await json('GET', `/api/goals?project=${project.id}`)).body.goals, [],
    'a navigation created a goal');

  // The shape the console actually uses must still work, or this test would
  // pass just as well against a route that refuses everything.
  const ok = await rawRequest('POST', '/api/goals', {
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
  }, body);
  assert.match(ok, /^HTTP\/1\.1 200 /, `the console's own shape must be served: ${ok.slice(0, 40)}`);
});

test('POST /api/goals refuses an unrecognised agent instead of substituting', async () => {
  // Silently falling back to AGENTS[0] does not merely surprise: the goal
  // record persists pmAgent, so the store would end up asserting the caller
  // asked for an agent they never named.
  const project = await makeProject();
  const r = await json('POST', '/api/goals', {
    projectId: project.id, text: 'plan it', agent: 'totally-bogus',
  });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /totally-bogus/, 'the refusal must name the agent');

  // and the refusal created nothing
  assert.deepStrictEqual((await json('GET', `/api/goals?project=${project.id}`)).body.goals, [],
    'a refused agent still created a goal');
});

test('POST /api/goals refuses when no agent is installed at all', async () => {
  // Same branch as the unrecognised id, other half: with nothing installed the
  // PM would be spawned as null and lib/plan would spend a goal record to say
  // what the request could have been told.
  const emptyBin = tmp('skillspace-goal-noagent-');
  const home = tmp('skillspace-goal-noagenthome-');
  // HOME as well as PATH: the shim lives in fakeHome/.local/bin and CHILD_PATH
  // prepends $HOME/.local/bin unconditionally, so hiding it means giving this
  // server a home that has no .local/bin at all.
  const emptyHome = tmp('skillspace-goal-noagenthome-empty-');
  const s = await startServer(home, { PATH: `${emptyBin}:/usr/bin:/bin`, HOME: emptyHome });
  try {
    const cfg = await (await fetch(s.base + '/api/config')).json();
    assert.deepStrictEqual(cfg.agents, [], 'fixture still found an agent');

    const project = await makeProject(undefined, s.base);
    const r = await json('POST', '/api/goals', { projectId: project.id, text: 'x' }, s.base);
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.deepStrictEqual((await json('GET', '/api/goals', undefined, s.base)).body.goals, []);
  } finally {
    await stopServer(s.child);
  }
});

test('a PM that returns prose leaves the goal failed with its output readable', async () => {
  // The PM is an agent, so "it answered in prose" is an ordinary Tuesday. The
  // goal has to end in a state a human can diagnose, which means the raw output
  // survives - it is the only evidence of what the prompt actually produced.
  const project = await makeProject();
  const r = await json('POST', '/api/goals', {
    projectId: project.id, text: `${PROSE_MARK} please plan this`,
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = await planned(r.body.goal.id);
  assert.strictEqual(after.goal.status, 'failed');
  assert.match(after.goal.error, /no JSON plan/);
  assert.ok(after.goal.rawPlan && after.goal.rawPlan.includes(PROSE),
    `the PM's own words were lost: ${JSON.stringify(after.goal.rawPlan)}`);
  assert.deepStrictEqual(after.orders, [], 'a failed plan persisted orders anyway');
});

test('goals still planning are reconciled to failed on boot', async () => {
  // A goal still marked planning lost the PM that was decomposing it when the
  // previous server died. It is never assumed to have produced a plan.
  const home = tmp('skillspace-goalreconcile-');
  const id = seedGoal(home, 'planning');
  // A `running` goal is deliberately NOT reconciled - its orders are reconciled
  // individually by lib/orders, and nothing here can say whether the goal as a
  // whole finished. Seeded alongside so a reconcile that swept everything would
  // be caught rather than pass.
  const untouched = seedGoal(home, 'running');

  const s = await startServer(home);
  try {
    const r = await json('GET', '/api/goals/' + id, undefined, s.base);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.goal.status, 'failed',
      'a planning goal survived a restart still marked planning');
    assert.match(r.body.goal.error, /interrupted while planning/);

    // and on disk, which is what the next boot will read
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'goals', id + '.json'), 'utf8'));
    assert.strictEqual(raw.status, 'failed');

    const other = await json('GET', '/api/goals/' + untouched, undefined, s.base);
    assert.strictEqual(other.body.goal.status, 'running',
      'the reconcile swept a running goal it cannot judge');
  } finally {
    await stopServer(s.child);
  }
});

test('a rejection from the planner is reported rather than swallowed', async () => {
  // decompose records its own failures ON the goal, so a REJECTION means a bug
  // in lib/plan rather than a PM that could not plan - the one outcome with no
  // durable trace unless the route writes one. Reaching it from outside takes a
  // real fault: goals.planned() is the LAST statement of the plan path and sits
  // outside every try, so a goals/ directory that is readable but not writable
  // at the moment the PM finishes makes it throw after the orders are already
  // on disk.
  //
  // What can be asserted here is the console line, and only that: the catch's
  // own failPlanning() writes to the very directory whose unwritability caused
  // the rejection, so in this scenario it cannot succeed either. Without the
  // catch at all the rejection is unhandled, which in Node 24 takes the server
  // down - so this pins both halves that are reachable.
  const home = tmp('skillspace-goalreject-');
  const s = await startServer(home);
  try {
    const project = await makeProject(undefined, s.base);
    const r = await json('POST', '/api/goals', {
      projectId: project.id, text: `${NAP_MARK} plan while the store closes`,
    }, s.base);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    // The goal file exists by now (the POST returned it), so the directory is
    // there to chmod. The PM is still napping.
    const gdir = path.join(home, 'goals');
    await waitFor('the goal record to land', async () => fs.existsSync(gdir));
    fs.chmodSync(gdir, 0o500);
    try {
      await waitFor('the planner to reject', async () => /failed to plan/.test(s.stderr()));
    } finally {
      fs.chmodSync(gdir, 0o700);
    }
    assert.match(s.stderr(), new RegExp(`goal ${r.body.goal.id} failed to plan`),
      'the rejection did not name the goal it belonged to');
    // And the server is still serving - an unhandled rejection would have taken
    // it down instead.
    assert.strictEqual((await json('GET', '/api/goals', undefined, s.base)).status, 200,
      'the server did not survive the rejection');
  } finally {
    await stopServer(s.child);
  }
});

test('a PM started over HTTP occupies a slot in the process-wide agent ceiling', async () => {
  // lib/plan.inFlightCount() is wired into server.js's agentsRunning(), but
  // that wiring was written before this route existed. A PM is a credentialed
  // agent like any other: while one runs, the ceiling must already be full.
  // Measured end to end, through the server, because the library-level count is
  // exactly the part that was already known to be right.
  const home = tmp('skillspace-goalceiling-');
  const s = await startServer(home, { SKILLSPACE_MAX_RUNS: '1' });
  try {
    const project = await makeProject(undefined, s.base);
    const mark = `PM-CEILING-${process.pid}-${Date.now()}`;
    const alive = () => {
      try { return Number(execSync(`pgrep -f ${mark} | wc -l`).toString().trim()); } catch (_) { return 0; }
    };
    const g = await json('POST', '/api/goals', {
      projectId: project.id, text: `${SLOW_MARK} ${mark}`,
    }, s.base);
    assert.strictEqual(g.status, 200, JSON.stringify(g.body));

    // Guard against a vacuous pass: a 429 below means nothing unless the PM is
    // genuinely running when it is asked for.
    for (let i = 0; i < 100 && alive() === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(alive() > 0, 'the PM never started, so this proves nothing about the ceiling');

    // An order on a DIFFERENT project, so what refuses it is the global agent
    // ceiling and not the per-directory serialisation.
    const other = await makeProject(undefined, s.base);
    const o = await json('POST', '/api/orders', {
      projectId: other.id, prompt: 'sneaks past the ceiling',
    }, s.base);
    assert.strictEqual(o.status, 429,
      `the orders route could not see the PM's slot: ${JSON.stringify(o.body)}`);

    // /api/run counts the same pool.
    const run = await fetch(`${s.base}/api/run?skill=x&task=third agent`, {
      headers: { 'Sec-Fetch-Mode': 'cors' },
    });
    const text = await run.text();
    assert.strictEqual(run.status, 429, `/api/run kept its own pool: ${run.status} ${text.slice(0, 80)}`);

    // And a second GOAL is refused too, without leaving a record. Nothing
    // retries a goal, so a goal admitted past the ceiling would either start an
    // agent over the bound or sit in `planning` until the next reboot.
    const g2 = await json('POST', '/api/goals', {
      projectId: other.id, text: 'wants in',
    }, s.base);
    assert.strictEqual(g2.status, 429, `a second PM was admitted: ${JSON.stringify(g2.body)}`);
    const listed = (await json('GET', `/api/goals?project=${other.id}`, undefined, s.base)).body.goals;
    assert.deepStrictEqual(listed, [], 'the refused goal was recorded anyway');

    // ORDER OF THE TWO REFUSALS. A caller fault is checked before the capacity
    // bound, so a bad agent id is not masked by a 429 the client would sensibly
    // retry - forever, since retrying never makes the id valid. Only reachable
    // with the ceiling genuinely full, which is why it lives here.
    const bad = await json('POST', '/api/goals', {
      projectId: other.id, text: 'wants in', agent: 'totally-bogus',
    }, s.base);
    assert.strictEqual(bad.status, 400,
      `a full ceiling masked a caller fault: ${bad.status} ${JSON.stringify(bad.body)}`);
    assert.match(bad.body.error, /totally-bogus/);
  } finally {
    await stopServer(s.child);
  }
});

test('shutting the server down cancels its PM instead of orphaning it', async () => {
  // The timeout that bounds a stuck agent is a setTimeout inside the server
  // process, and agents are spawned detached - their own process group - so
  // they never see a signal sent to the server's. plan.cancelAll() is wired
  // into the shutdown handler, but that wiring predates this route: this is
  // what proves it covers a PM started over HTTP.
  const home = tmp('skillspace-goalshutdown-');
  const s = await startServer(home);
  const project = await makeProject(undefined, s.base);

  const mark = `PM-SHUTDOWN-${process.pid}-${Date.now()}`;
  const alive = () => {
    try { return Number(execSync(`pgrep -f ${mark} | wc -l`).toString().trim()); } catch (_) { return 0; }
  };

  const g = (await json('POST', '/api/goals', {
    projectId: project.id, text: `${SLOW_MARK} ${mark}`,
  }, s.base)).body.goal;

  for (let i = 0; i < 100 && alive() === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(alive() > 0, 'the PM never started, so this proves nothing about shutdown');

  s.child.kill('SIGTERM');
  await new Promise((r) => s.child.on('exit', r));
  for (let i = 0; i < 80 && alive() > 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(alive(), 0, 'the PM outlived the server with no time bound');

  // and the record says why it ended, rather than leaving the next boot's
  // reconcile to call it merely "interrupted"
  const rec = JSON.parse(fs.readFileSync(path.join(home, 'goals', g.id + '.json'), 'utf8'));
  assert.strictEqual(rec.status, 'failed',
    'the server exited before the cancelled goal recorded its outcome');
  assert.match(rec.error, /cancelled/);
});

test('the goals route factory refuses to construct without every dependency it needs', async () => {
  // Destructuring a missing key binds `undefined`, so a factory that forgot one
  // constructs happily and fails at the first request that needs it - in a
  // handler, as a bare TypeError, with no hint that the cause was the wiring.
  const makeGoalRoutes = require('../routes/goals');
  const stub = () => {};
  const full = {
    root: storeRoot, sendJson: stub, readBody: stub,
    OVERSIZE: Symbol('o'), ABORTED: Symbol('a'), plainIdFrom: stub,
    isTopLevelNavigation: stub, denyNavigation: stub,
    AGENTS: [], maxConcurrentRuns: 4, childEnv: stub,
  };
  // The wiring is right, so this must still construct - otherwise every
  // assertion below passes for the wrong reason.
  assert.strictEqual(typeof makeGoalRoutes(full), 'function');

  for (const key of Object.keys(full)) {
    const { [key]: _omitted, ...rest } = full;
    assert.throws(
      () => makeGoalRoutes(rest),
      (e) => e instanceof TypeError && e.message.includes(key),
      `omitting ${key} constructed the goals route anyway`
    );
  }
});

// Last, so every server this file started has had its chance to write.
test("the suite does not touch the developer's own experts.json", async () => {
  // Provoke a write first. Without this the assertion is vacuous: nothing else
  // in this file calls /api/experts, so the repo file would be untouched even
  // with the override removed.
  const w = await json('POST', '/api/experts', { name: 'goal-rig-probe', summary: 'written by the suite' });
  assert.strictEqual(w.status, 200, `the write must actually happen: ${JSON.stringify(w.body)}`);
  assert.ok(fs.existsSync(path.join(storeRoot, 'experts.json')),
    'the override is set but the server wrote somewhere else');

  const now = fs.existsSync(REPO_EXPERTS) ? fs.readFileSync(REPO_EXPERTS, 'utf8') : null;
  assert.strictEqual(now, expertsBefore,
    'running the tests rewrote the repo experts.json - SKILLSPACE_EXPERTS_FILE is not reaching the server');
});
