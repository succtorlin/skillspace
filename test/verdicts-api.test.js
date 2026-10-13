'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync, execFileSync } = require('child_process');
const net = require('net');
const { secretFrom, register } = require('./helpers/auth');

const store = require('../lib/store');
const goals = require('../lib/goals');
const orders = require('../lib/orders');
const { VERDICT_OPENING } = require('../lib/pm');

// Plan 2d's surface from the outside: the judge wired into a real server
// process, its boot reconcile and its shutdown reap, and the two human doors -
// POST /api/orders/:id/retry and POST /api/orders/:id/verdict/retry - plus the
// chains every GET now carries beside its records.
//
// The harness is COPIED from test/scheduler-api.test.js, helper for helper and
// verbatim except for temp-directory prefixes, including its agent rig, which is
// not optional: every server below can spawn an agent, and a rig that failed
// open would run the user's own `claude` on their account. The rig assertions
// in startServer are what make that structural rather than assumed. No real
// agent runs here: both rigged agents are the shell script below.
//
// A SERVER PER TEST, each stopped by the test that started it, for the reasons
// the sibling file gives. There is no shared `base`: `json` must always be
// handed the server it is talking to.
const created = [];
const children = [];
// Every pgrep marker this file hands to an agent. Cleaned up in after() even on
// failure: the shutdown tests exist precisely to catch an agent that outlived
// its server, so a FAILING run is exactly the run that leaks one.
const marks = [];

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

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

let fakeBin, fakeHome;
const SLOW_JUDGE = 'SLOW-JUDGE';
// One script, three roles, picked by the prompt:
//   a VERDICT prompt   rejects an order whose instruction carries
//                      JUDGE-REJECTS-ONCE unless it also carries feedback;
//                      sleeps first if it carries SLOW-JUDGE; else verifies
//   a PM prompt        plans one order - whose prompt carries JUDGE-REJECTS-ONCE
//                      when the goal text says RETRY-ME
//   an order prompt    prints that same plan text and exits 0: `succeeded`
const SHIM = `#!/bin/sh
case "$2" in
  *"${VERDICT_OPENING}"*)
    case "$2" in *${SLOW_JUDGE}*) sleep 30 ;; esac
    case "$2" in
      *"REVIEWER FEEDBACK"*) printf '%s\\n' '{"verdict":"verified","reason":"fixed"}' ;;
      *JUDGE-REJECTS-ONCE*) printf '%s\\n' '{"verdict":"rejected","reason":"add the missing test"}' ;;
      *) printf '%s\\n' '{"verdict":"verified","reason":"looks right"}' ;;
    esac
    exit 0 ;;
esac
case "$2" in
  *RETRY-ME*)
cat <<'JSON'
[{"title":"one","prompt":"do one JUDGE-REJECTS-ONCE","acceptance":"one is done"}]
JSON
  ;;
  *)
cat <<'JSON'
[{"title":"one","prompt":"do one","acceptance":"one is done"}]
JSON
  ;;
esac
exit 0
`;

// TWO shims, for the same reason test/goals-api.test.js keeps two: with a
// single agent installed, an agentFor that ignores what was asked for and
// always hands back AGENTS[0] passes everything, because the two are the same
// binary. AGENTS is built in this order by server.js's detectAgents, so
// AGENTS[0] is `claude` and `codex` is the one that can only be reached by
// being named.
const RIG_AGENTS = ['claude', 'codex'];

function rigAgent() {
  fakeBin = tmp('vrd-bin-');            // kept empty: a decoy that must NOT resolve
  fakeHome = tmp('vrd-fakehome-');
  const localBin = path.join(fakeHome, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  for (const id of RIG_AGENTS) {
    // buildArgs is (p) => ['-p', p] for claude and (p) => ['exec', p] for
    // codex, so the prompt is $2 either way and one script serves both.
    const shim = path.join(localBin, id);
    fs.writeFileSync(shim, SHIM);
    fs.chmodSync(shim, 0o755);
  }
}

function childEnvFor(home) {
  return {
    ...process.env,
    HOME: fakeHome,
    // fakeBin is empty and stays that way: the ONLY route to the shim is
    // $HOME/.local/bin, which only server.js's CHILD_PATH provides.
    PATH: `${fakeBin}:/usr/bin:/bin`,
    SKILLSPACE_HOME: home,
    SKILLSPACE_EXPERTS_FILE: path.join(home, 'experts.json'),
    // Explicitly ON. The two sibling API files set this to '0' because they
    // test the human dispatch door; naming it here rather than relying on the
    // default means this file still means something if that default is ever
    // flipped, and a run of the whole suite cannot leave it set to '0' in the
    // environment and quietly turn every test below into a tautology.
    SKILLSPACE_SCHEDULER: '1',
  };
}

async function waitFor(what, predicate, timeoutMs = 30000) {
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
  let err = '';
  let out = '';
  proc.stderr.on('data', (c) => (err += c));
  proc.stdout.on('data', (c) => (out += c));
  // Every /api/* call needs the per-boot secret, published only as the
  // link on stdout. test/helpers/auth.js adds it to fetch from here on.
  register(port, await secretFrom(proc));
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
  // Every agent this server can see must be a shim, or a test below would run
  // the user's own agent. The empty set is not legitimate in this file - every
  // test needs the loop to actually dispatch something - so this asserts the
  // POSITIVE case, unlike the sibling files' `every`.
  const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  assert.deepStrictEqual(cfg.agents, RIG_AGENTS,
    `test rig did not isolate the agent: ${JSON.stringify(cfg.agents)}`);

  return {
    child: proc, port, base: `http://127.0.0.1:${port}`,
    stdout: () => out,
    stderr: () => err,
  };
}

// SIGTERM, never SIGKILL first: SIGKILL skips the server's own shutdown
// handler, so a detached agent - whose only time bound is a setTimeout inside
// that process - is orphaned. Which is the very thing three tests here measure.
async function stopServer(child, ms = 10000) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + ms;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

// A marker that reaches the shim's argv, so an agent is findable by pgrep - the
// order record carries no pid. Registered for cleanup at the moment it is
// created, not at the moment it is used.
function newMark(what) {
  const m = `SCHED-${what}-${process.pid}-${Date.now()}-${marks.length}`;
  marks.push(m);
  return m;
}

// execFileSync, NOT the `execSync('pgrep -f MARK | wc -l')` idiom the sibling
// files use. Two reasons, and only the second is established:
//
// The shell form runs under `sh -c`, so for as long as that shell lives there
// is a process whose command line contains the marker. Whether pgrep can ever
// see it was TESTED, not assumed, after this file's one unexplained failure:
// 0 false positives in 300 tries idle and 300 under eight busy cores. So this
// is not a fix for a demonstrated bug - it removes a candidate rather than a
// known cause, which is the honest description of it.
//
// What it definitely buys is the pids. `| wc -l` throws away everything except
// a number, and a bare `1 !== 0` on a process count is not diagnosable after
// the fact. pgrep never matches its own process, so spawning it directly with
// no shell in between leaves nothing to filter out.
//
// pgrep exits 1 when nothing matches, which execFileSync raises; that is the
// ordinary case, not an error.
function alivePids(mark) {
  try {
    return execFileSync('pgrep', ['-f', mark]).toString().trim().split('\n').filter(Boolean);
  } catch (_) { return []; }
}
const aliveCount = (mark) => alivePids(mark).length;

// What matched, for an assertion message. A bare `1 !== 0` on a process count
// is not diagnosable after the fact - it happened once here, under a pair of
// concurrent suite runs, and left nothing to go on.
function whatMatched(mark) {
  try { return execFileSync('pgrep', ['-fl', mark]).toString().trim() || '(nothing)'; } catch (_) { return '(nothing)'; }
}

const REPO_EXPERTS = path.join(__dirname, '..', 'experts.json');
let expertsBefore;

before(() => {
  expertsBefore = fs.existsSync(REPO_EXPERTS) ? fs.readFileSync(REPO_EXPERTS, 'utf8') : null;
  rigAgent();
});

after(async () => {
  for (const c of children) await stopServer(c, 5000);
  // AFTER the servers are down, so an agent a passing test left in flight has
  // had its chance to be reaped by the shutdown path first - and one a FAILING
  // test orphaned is killed here rather than sleeping out its 30 seconds on the
  // developer's machine. No shell, for the same reason alivePids uses none, and
  // the throw is the ordinary case: pkill exits 1 when nothing matched.
  for (const m of marks) {
    try { execFileSync('pkill', ['-f', m], { stdio: 'ignore' }); } catch (_) {}
  }
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
  if (expertsBefore !== null) fs.writeFileSync(REPO_EXPERTS, expertsBefore);
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

// A real git repository, so each order gets its own worktree and two orders of
// one goal can run without touching each other's tree - which is what makes
// "the scheduler ran both" a safe thing to ask for at all.
function gitRepoDir() {
  const d = tmp('vrd-repo-');
  execSync('git init -q', { cwd: d });
  fs.writeFileSync(path.join(d, 'file.txt'), 'original\n');
  execSync('git add -A', { cwd: d });
  execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: d });
  return d;
}

async function makeGitProject(at) {
  const r = await json('POST', '/api/projects', { name: 'Sched', path: gitRepoDir() }, at);
  assert.strictEqual(r.status, 200, 'git project fixture failed: ' + JSON.stringify(r.body));
  assert.strictEqual(r.body.project.kind, 'git',
    'the fixture is not a git project, so its orders would be serialised by projectBusy');
  return r.body.project;
}

// Records written straight to the store, because the HTTP surface cannot
// produce them: POST /api/orders dispatches what it creates, so there is no
// route that leaves a queued order for the loop to find, and no route at all
// writes the crashed-process shape the boot-ordering test needs.
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

// The scheduler's own counters, which are the only observable for WHO
// dispatched an order. They lag the record deliberately: counts.started is
// incremented in the .then() of a runOrder that has ALREADY written
// `succeeded` to disk, so a test that reads them the moment the record settles
// is reading them one microtask early. That cost a spurious mutation KILL once
// - a flake dressed as a verdict - so every assertion on them below waits for
// the counter itself rather than for the record.
const stats = async (at) => (await json('GET', '/api/scheduler', undefined, at)).body.scheduler;

const readOrder = (root, id) =>
  JSON.parse(fs.readFileSync(path.join(root, 'orders', id + '.json'), 'utf8'));
const readGoal = (root, id) =>
  JSON.parse(fs.readFileSync(path.join(root, 'goals', id + '.json'), 'utf8'));

// ---------------------------------------------------------------- the wiring

test('a goal whose first attempt is rejected finishes on its second, over HTTP alone', async () => {
  // Plan 2d's deliverable end to end: state a goal; it plans, runs, is judged,
  // is rejected, is retried with the reason, is judged again, and is done.
  //
  // The goal NAMES codex as its PM, and the orders run on AGENTS[0] (claude)
  // because they name nothing. So `verdictAgent === pmAgent === 'codex'` is
  // what proves judgeFor resolves the goal's own PM rather than AGENTS[0] -
  // with one agent, or with the PM left to default, the two would be the same
  // binary and that mutant would pass.
  const home = tmp('vrd-e2ehome-');
  const s = await startServer(home, { SKILLSPACE_SCHEDULER_INTERVAL_MS: '100', SKILLSPACE_MAX_RUNS: '8' });
  try {
    const project = await makeGitProject(s.base);
    const posted = await json('POST', '/api/goals',
      { projectId: project.id, text: 'RETRY-ME please', agent: 'codex' }, s.base);
    assert.strictEqual(posted.status, 200, JSON.stringify(posted.body));
    const goalId = posted.body.goal.id;
    const done = await waitFor('the goal to finish', async () => {
      const r = await json('GET', '/api/goals/' + goalId, undefined, s.base);
      if (r.body.goal.status === 'failed' || r.body.goal.status === 'stalled') {
        throw new Error(`the goal ended ${r.body.goal.status}: ${r.body.goal.error}`);
      }
      return r.body.goal.status === 'done' && r.body;
    }, 90000);
    assert.strictEqual(done.goal.pmAgent, 'codex', 'the fixture did not name a PM');
    assert.strictEqual(done.orders.length, 2, 'one order, two attempts');
    const [first, second] = done.orders;
    assert.strictEqual(first.verdict, 'rejected');
    assert.strictEqual(first.verdictReason, 'add the missing test');
    assert.strictEqual(second.supersedes, first.id);
    assert.strictEqual(second.verdict, 'verified');
    assert.match(second.prompt, /REVIEWER FEEDBACK ON ATTEMPT 1/);
    for (const o of done.orders) {
      assert.strictEqual(o.agent, 'claude', 'the fixture meant orders to run on AGENTS[0]');
      assert.strictEqual(o.verdictAgent, done.goal.pmAgent, "the goal's own PM did not judge it");
    }
  } finally {
    await stopServer(s.child);
  }
});

test('a judgement interrupted by a restart is recorded, not resumed', async () => {
  // Mutant A: reconcileVerdicts not called - the order stays `judging` and its
  // goal reads `planned` (awaiting a verdict nothing will give).
  // Mutant B: reconcileVerdicts called AFTER scheduler.start - same reading at
  // a 30s interval, because the first tick is the only one this test sees.
  const home = tmp('vrd-boothome-');
  const o = seedOrder(home, 'succeeded', {
    prompt: 'judged once', goalId: null, seq: 0, startedAt: new Date().toISOString(),
    verdictState: 'judging', verdictRuns: 1,
  });
  const g = seedGoal(home, 'planned', { orderIds: [o] });
  store.writeJson(home, `orders/${o}.json`, { ...readOrder(home, o), goalId: g });
  const s = await startServer(home, { SKILLSPACE_SCHEDULER_INTERVAL_MS: '30000' });
  try {
    const rec = readOrder(home, o);
    assert.strictEqual(rec.verdictState, 'error');
    assert.strictEqual(rec.verdictError, 'interrupted while judging');
    assert.strictEqual(rec.verdictRuns, 1, 'a judge ran on boot');
    assert.strictEqual((await stats(s.base)).ticks, 1);
    const r = await json('GET', '/api/goals/' + g, undefined, s.base);
    assert.strictEqual(r.body.goal.status, 'stalled');
  } finally {
    await stopServer(s.child);
  }
});

test('a judge holds the shutdown drain open and is reaped by it', async () => {
  // Mutant A: verdict.inFlightCount() missing from agentsRunning() - the drain
  //   exits before the judge's record is written, which stays `judging`.
  // Mutant B: verdict.cancelAll() missing from the shutdown reap - the judge is
  //   still alive after the server is gone.
  const home = tmp('vrd-drainhome-');
  const s = await startServer(home, { SKILLSPACE_SCHEDULER_INTERVAL_MS: '100' });
  const mark = newMark(SLOW_JUDGE);
  try {
    const project = await makeGitProject(s.base);
    const o = seedOrder(home, 'succeeded', {
      projectId: project.id, prompt: `work ${mark} ${SLOW_JUDGE}`, seq: 0, startedAt: new Date().toISOString(),
    });
    const g = seedGoal(home, 'planned', { projectId: project.id, orderIds: [o] });
    store.writeJson(home, `orders/${o}.json`, { ...readOrder(home, o), goalId: g });
    await waitFor('the judge to be alive', () => aliveCount(mark) >= 1 && readOrder(home, o).verdictState === 'judging');
    await stopServer(s.child);
    const rec = readOrder(home, o);
    assert.strictEqual(rec.verdictState, 'error', `the drain exited over a live judge: ${JSON.stringify(rec)}`);
    assert.match(rec.verdictError, /cancelled/);
    await waitFor('the judge to be gone', () => aliveCount(mark) === 0, 10000)
      .catch(() => assert.fail(`a judge outlived the server: ${whatMatched(mark)}`));
  } finally {
    await stopServer(s.child);
  }
});

// ------------------------------------------------------------ the human doors

// Humans drive here, so the loop is OFF and every judgement or retry below is
// one the test caused.
async function humanServer(prefix) {
  const home = tmp(prefix);
  const s = await startServer(home, { SKILLSPACE_SCHEDULER: '0' });
  const project = await makeGitProject(s.base);
  return { home, s, project };
}

// A goal naming one finished order, written straight to the store.
function seedJudged(home, project, extra) {
  const o = seedOrder(home, 'succeeded', {
    projectId: project.id, prompt: 'add the flag', acceptance: 'the flag is tested',
    title: 'Flag', seq: 0, exitCode: 0, startedAt: new Date().toISOString(), ...(extra || {}),
  });
  const g = seedGoal(home, 'planned', { projectId: project.id, orderIds: [o], pmAgent: 'claude' });
  store.writeJson(home, `orders/${o}.json`, { ...readOrder(home, o), goalId: g });
  return { o, g };
}

// undici rewrites Sec-Fetch-Mode to `cors` on its own requests but leaves
// Sec-Fetch-Dest alone, and the server's guard refuses on EITHER - so this
// reaches the guard through its `document` half. The guard itself is pinned
// shape by shape over a raw socket in test/orders-api.test.js; what this pins
// is that the retry route calls it at all.
const NAV = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

test('POST /api/orders/:id/retry supersedes a rejected order and returns its chain', async () => {
  const { home, s, project } = await humanServer('vrd-retryhome-');
  try {
    const { o, g } = seedJudged(home, project, {
      verdictState: 'judged', verdict: 'rejected', verdictReason: 'no test', retryRefused: 'no attempts left (3 of 3)',
    });
    const before = readOrder(home, o);
    const r = await json('POST', `/api/orders/${o}/retry`, undefined, s.base);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.order.supersedes, o);
    assert.strictEqual(r.body.order.status, 'queued');
    assert.match(r.body.order.prompt, /no test/);
    assert.deepStrictEqual(r.body.chain, {
      rootId: o, headId: r.body.order.id, ids: [o, r.body.order.id],
      attempt: 2, attempts: 2, supersedes: o, supersededBy: null,
    });
    assert.deepStrictEqual(readGoal(home, g).orderIds, [o, r.body.order.id]);
    assert.deepStrictEqual(readOrder(home, o), before, 'the rejected order was touched');

    const again = await json('POST', `/api/orders/${o}/retry`, undefined, s.base);
    assert.strictEqual(again.status, 409);
    assert.match(again.body.error, /already superseded/);
    assert.strictEqual(again.body.supersededBy, r.body.order.id);
  } finally {
    await stopServer(s.child);
  }
});

test('two concurrent retries of one order create one attempt', async () => {
  // The authority is supersede()'s synchronous check-then-create, seen from
  // the wire. NOT a complete guard against an await creeping in: measured, it
  // catches a yield long enough for the second request to be read (a 5ms
  // timer) but not `await null` or a setImmediate. The synchronous contract
  // itself is pinned in test/attempts.test.js, where every await is caught.
  const { home, s, project } = await humanServer('vrd-racehome-');
  try {
    const { o, g } = seedJudged(home, project, { status: 'cancelled', startedAt: null });
    const [a, b] = await Promise.all([
      json('POST', `/api/orders/${o}/retry`, undefined, s.base),
      json('POST', `/api/orders/${o}/retry`, undefined, s.base),
    ]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
    assert.strictEqual(readGoal(home, g).orderIds.length, 2);
  } finally {
    await stopServer(s.child);
  }
});

test('POST /api/orders/:id/retry refuses what must not be retried', async () => {
  const { home, s, project } = await humanServer('vrd-refusehome-');
  try {
    const post = (id, headers) => fetch(`${s.base}/api/orders/${id}/retry`, { method: 'POST', headers });
    const queued = seedJudged(home, project, { status: 'queued', startedAt: null }).o;
    const verified = seedJudged(home, project, { verdictState: 'judged', verdict: 'verified', verdictReason: 'ok' }).o;
    const awaiting = seedJudged(home, project).o;
    assert.strictEqual((await post(queued)).status, 409);
    assert.strictEqual((await post(verified)).status, 409);
    const aw = await post(awaiting);
    assert.strictEqual(aw.status, 409);
    assert.match((await aw.json()).error, /awaiting its verdict/);
    assert.strictEqual((await post('ord-nope')).status, 404);
    assert.strictEqual((await post('..%2F..%2Fetc')).status, 400);
    const cancelled = seedJudged(home, project, { status: 'cancelled', startedAt: null });
    const nav = await post(cancelled.o, NAV);
    assert.strictEqual(nav.status, 403, 'a link clicked in Mail must not start work');
    assert.strictEqual(readGoal(home, cancelled.g).orderIds.length, 1, 'the refused request created an order');
    // POST only. 2b's dispatch route once answered GET and spawned an agent.
    const got = await fetch(`${s.base}/api/orders/${cancelled.o}/retry`);
    assert.strictEqual(got.status, 404, 'the retry door answered a GET');
    assert.strictEqual(readGoal(home, cancelled.g).orderIds.length, 1, 'a GET created an order');
  } finally {
    await stopServer(s.child);
  }
});

test('POST /api/orders/:id/retry answers 429 at the daily cap', async () => {
  const home = tmp('vrd-caphome-');
  const s = await startServer(home, { SKILLSPACE_SCHEDULER: '0' });
  try {
    const r = await json('POST', '/api/projects', { name: 'Capped', path: gitRepoDir(), budget: { maxOrdersPerDay: 1 } }, s.base);
    const { o } = seedJudged(home, r.body.project, { status: 'cancelled', startedAt: null });
    const res = await json('POST', `/api/orders/${o}/retry`, undefined, s.base);
    assert.strictEqual(res.status, 429);
    assert.match(res.body.error, /daily limit/);
  } finally {
    await stopServer(s.child);
  }
});

test('POST /api/orders/:id/verdict/retry re-judges an errored verdict, once at a time', async () => {
  const { home, s, project } = await humanServer('vrd-vretryhome-');
  try {
    const { o } = seedJudged(home, project, {
      verdictState: 'error', verdictError: 'the PM returned no JSON verdict', verdictRuns: 1,
    });
    const [a, b] = await Promise.all([
      json('POST', `/api/orders/${o}/verdict/retry`, {}, s.base),
      json('POST', `/api/orders/${o}/verdict/retry`, {}, s.base),
    ]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 409], 'judge() admission is the authority');
    const ok = a.status === 200 ? a : b;
    assert.strictEqual(ok.body.order.verdictState, 'judging');
    const rec = await waitFor('the verdict', () => {
      const x = readOrder(home, o);
      return x.verdictState === 'judged' && x;
    });
    assert.strictEqual(rec.verdict, 'verified');
    assert.strictEqual(rec.verdictRuns, 2);
    assert.strictEqual(rec.verdictAgent, 'claude', "the goal's own PM judged it");
  } finally {
    await stopServer(s.child);
  }
});

test('POST /api/orders/:id/verdict/retry refuses what cannot or must not be judged', async () => {
  const { home, s, project } = await humanServer('vrd-vrefusehome-');
  try {
    const post = (id, body) => json('POST', `/api/orders/${id}/verdict/retry`, body || {}, s.base);
    const judged = seedJudged(home, project, { verdictState: 'judged', verdict: 'rejected', verdictReason: 'r' }).o;
    assert.match((await post(judged)).body.error, /already judged: rejected/);
    const cancelled = seedJudged(home, project, { status: 'cancelled', startedAt: null }).o;
    const c = await post(cancelled);
    assert.strictEqual(c.status, 409);
    assert.match(c.body.error, /no result to judge/);
    const loose = seedOrder(home, 'succeeded', { projectId: project.id, startedAt: new Date().toISOString() });
    assert.match((await post(loose)).body.error, /outside a goal/);
    const named = await post(seedJudged(home, project, { verdictState: 'error' }).o, { agent: 'nope' });
    assert.strictEqual(named.status, 400, 'a named agent that does not exist is the caller\'s fault');
    // The other half of that line: a STORED pmAgent that is no longer installed
    // is the state's fault, not the caller's - 409, never 400.
    const stale = seedJudged(home, project, { verdictState: 'error' });
    store.writeJson(home, `goals/${stale.g}.json`, { ...readGoal(home, stale.g), pmAgent: 'gone' });
    const st = await post(stale.o);
    assert.strictEqual(st.status, 409, JSON.stringify(st.body));
    assert.strictEqual((await post('ord-nope')).status, 404);
    // POST only: a GET must not start a credentialed judge.
    const got = await fetch(`${s.base}/api/orders/${stale.o}/verdict/retry`);
    assert.strictEqual(got.status, 404, 'the verdict door answered a GET');
    assert.strictEqual(readOrder(home, stale.o).verdictState, 'error', 'a GET started a judge');
  } finally {
    await stopServer(s.child);
  }
});

test('chains come beside the records on every GET, never inside them', async () => {
  const { home, s, project } = await humanServer('vrd-gethome-');
  try {
    const { o, g } = seedJudged(home, project, {
      verdictState: 'judged', verdict: 'rejected', verdictReason: 'r', retryRefused: 'cap',
    });
    const next = (await json('POST', `/api/orders/${o}/retry`, undefined, s.base)).body.order.id;

    const one = await json('GET', `/api/orders/${next}`, undefined, s.base);
    assert.strictEqual(one.body.chain.attempt, 2);
    assert.strictEqual(one.body.chain.rootId, o);
    assert.strictEqual(one.body.order.supersededBy, undefined, 'a derivation leaked into the record');

    const root = await json('GET', `/api/orders/${o}`, undefined, s.base);
    assert.strictEqual(root.body.chain.supersededBy, next);

    const goal = await json('GET', `/api/goals/${g}`, undefined, s.base);
    assert.strictEqual(goal.body.chains[o].attempt, 1);
    assert.strictEqual(goal.body.chains[next].attempt, 2);

    const list = await json('GET', `/api/orders?project=${project.id}`, undefined, s.base);
    assert.strictEqual(list.body.chains[next].supersedes, o);
  } finally {
    await stopServer(s.child);
  }
});
