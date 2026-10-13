'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync, execFileSync } = require('child_process');
const net = require('net');

const store = require('../lib/store');
const goals = require('../lib/goals');
const orders = require('../lib/orders');
const { VERDICT_OPENING } = require('../lib/pm');

// The wired scheduler, from the outside: a server process with the loop running
// in it, driven only over HTTP and the store. lib/scheduler's own unit tests
// call start() in-process; nothing there can tell whether server.js ever calls
// it, in what order relative to the boot reconciles, or whether it is stopped
// before the shutdown reap. Those are the three things this file exists for,
// plus the status route.
//
// Modelled on test/goals-api.test.js, including its agent rig, which is not
// optional: every test below spawns a real credentialed agent, and a rig that
// failed open would run the user's own `claude` on their account against a
// temp directory. The rig assertions in startServer are what make that
// structural rather than assumed.
//
// A SERVER PER TEST, unlike the sibling API files, and the scheduler is why. It
// dispatches EVERY queued order in the store it can run, so two tests sharing
// one SKILLSPACE_HOME would have each other's fixtures running under them. Only
// the route-shape tests and the two contention tests share one, because neither
// pair leaves the other anything to dispatch.
//
// EACH TEST STOPS ITS OWN SERVER when it is done, rather than leaving them all
// to after(). Left running, eight servers - each polling its store on a timer,
// each holding a git worktree or two - stay alive for the whole file, and
// `node --test` runs files in parallel. That sustained load is not free to the
// rest of the suite: test/runner.test.js asserts wall-clock budgets (a ~2s
// stdio grace against a 4s bound, a 5s liveness precondition), and it was those
// budgets that went over when two full suites ran at once. after() still stops
// everything, so a FAILING test cannot leak one.

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

// The shim, chosen by the PROMPT - which for a PM run embeds the goal's text
// verbatim, and for an order run IS the order's prompt. So one script serves
// both roles and a marker in either picks the behaviour:
//
//   SLOW-AGENT  sleep, so an agent can be caught alive by pgrep and so
//               "the scheduler dispatched into a shutting-down server" is
//               observable as a live process rather than inferred
//   otherwise   print a two-order plan and exit 0
//
// An ORDER whose prompt has no marker therefore prints the plan text and exits
// 0, which is a `succeeded` order. That is all the deliverable test needs from
// it: the point is who dispatched it, not what it wrote.
//
// A VERDICT prompt (it opens with pm.VERDICT_OPENING) answers verified - checked
// first, because a verdict prompt embeds the order's own prompt.
let fakeBin, fakeHome;
const SLOW_MARK = 'SLOW-AGENT';
const SLOW_SECONDS = 30;

const SHIM = `#!/bin/sh
case "$2" in
  *"${VERDICT_OPENING}"*) printf '%s\\n' '{"verdict":"verified","reason":"the shim approves"}'; exit 0 ;;
esac
case "$2" in
  *${SLOW_MARK}*) sleep ${SLOW_SECONDS} ;;
esac
cat <<'JSON'
[{"title":"one","prompt":"do one","acceptance":"one is done"},
 {"title":"two","prompt":"do two","acceptance":"two is done"}]
JSON
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
  fakeBin = tmp('sched-bin-');            // kept empty: a decoy that must NOT resolve
  fakeHome = tmp('sched-fakehome-');
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

// One request that has been ACCEPTED but never completed: full headers, a
// Content-Length, and only part of the body. server.js's readBody waits for
// 'end', so the handler stays pending and the connection stays ACTIVE - which
// is what server.close() waits on, and therefore what keeps `closed` false in
// the shutdown drain.
//
// AN IDLE KEEP-ALIVE SOCKET DOES NOT DO THIS, and that was measured rather
// than assumed - the first version of this helper held one and the server
// exited inside two seconds anyway, taking the test's whole window with it.
// Worth recording beyond this file: server.js's own KNOWN LIMIT says
// "server.close() does not close a client's idle keep-alive socket", and on
// Node 24 it does. That note describes an /api/run stream, which is a
// connection with a request still in flight - which is what this opens, and
// what actually holds `closed` false.
//
// /api/projects because it is the cheapest route that actually awaits a body.
// Nothing is ever created: destroying the socket makes readBody resolve with
// its ABORTED sentinel, which that route answers by returning without writing.
function holdActiveRequest(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write('POST /api/projects HTTP/1.1\r\nHost: 127.0.0.1\r\n'
        + 'Content-Type: application/json\r\nContent-Length: 400\r\n\r\n');
      // A few bytes so the request body is genuinely in progress rather than
      // merely announced, then nothing.
      sock.write('{"na');
      // The socket is connected and the server has the headers; there is no
      // response to wait for, by construction.
      setTimeout(() => resolve(sock), 150);
    });
    setTimeout(() => reject(new Error('could not open the holding connection')), 10000).unref();
  });
}

let base, storeRoot;
// A second shared server, at the SHIPPED cadence and with the loop on, for the
// two tests that measure a human and the loop contending for the same order.
// Shared because they run in order and each waits for its own order to settle,
// and because a server per test is what this file's process load is already
// made of.
let schedBase, schedHome, schedProject;

const REPO_EXPERTS = path.join(__dirname, '..', 'experts.json');
let expertsBefore;

before(async () => {
  expertsBefore = fs.existsSync(REPO_EXPERTS) ? fs.readFileSync(REPO_EXPERTS, 'utf8') : null;
  rigAgent();
  storeRoot = tmp('sched-home-');
  // Shared by the two route-shape tests that need a server; the third is a
  // unit test of the factory and starts none. Nothing is ever seeded into this
  // store, so the loop has nothing to dispatch and the two cannot disturb each
  // other through it.
  const s = await startServer(storeRoot, { SKILLSPACE_SCHEDULER_INTERVAL_MS: '200' });
  base = s.base;

  schedHome = tmp('sched-racehome-');
  const r = await startServer(schedHome, {
    // EMPTIED, not omitted. childEnvFor spreads process.env, so a developer who
    // exported SKILLSPACE_SCHEDULER_INTERVAL_MS while debugging would otherwise
    // hand this server a cadence that is not the shipped one - and the two
    // tests below would then measure a race the product does not have. An empty
    // string is Number('') === 0, which lib/scheduler reads as unconfigured and
    // answers with its own default. The assertion on intervalMs is what makes
    // that structural rather than hopeful.
    SKILLSPACE_SCHEDULER_INTERVAL_MS: '',
    SKILLSPACE_MAX_RUNS: '8',
  });
  schedBase = r.base;
  schedProject = await makeGitProject(schedBase);
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
  const d = tmp('sched-repo-');
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

// ---------------------------------------------------------------- the route

test('GET /api/scheduler reports that it is running', async () => {
  // Kills the mutant that matters most for this whole task: server.js never
  // calling scheduler.start(). stats() still answers 200 in that case - the
  // module exports it whether or not the loop was ever started - so a test that
  // only checked the status code would pass over a console that dispatches
  // nothing. `running` is the field that tells them apart.
  const r = await json('GET', '/api/scheduler');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const first = r.body.scheduler;
  assert.ok(first, 'the response is not enveloped like every sibling route');
  assert.strictEqual(first.running, true, 'the server booted without starting the scheduler');
  assert.strictEqual(first.intervalMs, 200, 'the configured cadence did not reach start()');
  assert.match(first.startedAt, /^\d{4}-\d\d-\d\dT/, 'startedAt is not an ISO timestamp');

  // It is TICKING, not merely armed. `running` is `!!timer`, which stays true
  // through a loop that throws on every tick, so on its own it cannot tell a
  // working scheduler from a wedged one. lastTickAt is the field that can.
  const ticked = await waitFor('the scheduler to tick', async () => {
    const now = await stats();
    return now.ticks > 0 && now.lastTickAt ? now : false;
  }, 10000);
  assert.strictEqual(ticked.errors, 0, `the scheduler is erroring: ${ticked.lastError}`);

  // The two shape decisions this route was written around, pinned so that
  // "expose stats() verbatim" cannot quietly become "expose a nicer subset".
  //
  // `offered` counts dispatch ATTEMPTS and `started` counts starts; they
  // genuinely differ, and lib/scheduler renamed the first away from
  // `dispatched` because a probe read five "dispatched" while all five orders
  // were already `failed`. Dropping either half puts that back.
  assert.ok('offered' in first && 'started' in first,
    'offered and started must both be exposed, or a panel is back to labelling offers as starts');
  // lastError is never cleared on its own, so without lastErrorAt a panel
  // cannot tell "erroring now" from "errored once at boot an hour ago" and the
  // indicator stays red forever. They ship as a pair or not at all.
  assert.ok('lastError' in first && 'lastErrorAt' in first,
    'lastError without lastErrorAt is a red indicator with no way to age it out');
});

test('GET /api/scheduler answers GET and nothing else', async () => {
  // THE MUTANT THAT MATTERS MOST, inherited from plan 2b: a dispatch route was
  // written without a method test, answered ANY verb, and so a GET could spawn
  // a credentialed agent. It survived the first mutation sweep. Nothing here
  // spawns anything - this route reads a counter - but a handler that answers
  // every verb is the shape that was wrong then, and the next route copied from
  // this one inherits whichever shape it finds.
  //
  // Dropping `&& req.method === 'GET'` makes every one of these 200 with a
  // stats body. Falling through to the server's 404 is the correct answer.
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await json(method, '/api/scheduler');
    assert.strictEqual(r.status, 404, `${method} /api/scheduler was answered: ${r.status}`);
    assert.strictEqual(r.body.scheduler, undefined,
      `${method} /api/scheduler returned the scheduler's stats`);
  }
  // The shape the console actually uses must still work, or this would pass
  // just as well against a route that refuses everything.
  assert.strictEqual((await json('GET', '/api/scheduler')).status, 200);
});

test('the scheduler route factory refuses to construct without its dependencies', async () => {
  // routes/deps.js exists because two route factories carried a comment
  // promising that a missing key was "a boot-time fault rather than a TypeError
  // on the first request", and it was not: destructuring a missing key binds
  // undefined and the factory constructs happily. A fourth module repeating the
  // promise without the call would repeat the bug, so the call is pinned rather
  // than the comment.
  const makeSchedulerRoutes = require('../routes/scheduler');
  assert.throws(() => makeSchedulerRoutes({}), (e) => {
    assert.ok(e instanceof TypeError, `not a TypeError: ${e}`);
    assert.match(e.message, /^routes\/scheduler: /, 'the fault does not name the module');
    assert.match(e.message, /sendJson/, 'the fault does not name the missing key');
    return true;
  });
  assert.throws(() => makeSchedulerRoutes(), /dependencies object is required/);
  // And the positive control, or the assertions above would pass just as well
  // against a factory that threw unconditionally.
  assert.strictEqual(typeof makeSchedulerRoutes({ sendJson() {} }), 'function');
});

// ------------------------------------------------------------ the deliverable

test('a goal posted over HTTP runs to completion with nobody dispatching', async () => {
  // THE DELIVERABLE OF PLAN 2c, end to end and over the wire only: state a
  // goal, and its orders run. Nothing in this test calls
  // POST /api/orders/:id/dispatch - which until now was the ONLY way a planned
  // order could ever start - and the orders reach `succeeded` anyway.
  //
  // A GIT project deliberately: each order gets its own worktree, so the two
  // can run without the second waiting on projectBusy, and "it really ran
  // somewhere isolated" is observable on the record.
  const home = tmp('sched-e2ehome-');
  const s = await startServer(home, {
    SKILLSPACE_SCHEDULER_INTERVAL_MS: '100',
    // Room for the PM plus both of its orders; the ceiling is not what this
    // test is about, and at the default of 4 the PM's own slot would make the
    // measurement about capacity rather than about who dispatched.
    SKILLSPACE_MAX_RUNS: '8',
  });
  const project = await makeGitProject(s.base);

  const posted = await json('POST', '/api/goals', {
    projectId: project.id, text: 'ship the thing',
  }, s.base);
  assert.strictEqual(posted.status, 200, JSON.stringify(posted.body));
  const goalId = posted.body.goal.id;

  // Wait on the thing being asserted, not on a faster proxy for it: the claim
  // is that BOTH orders end `succeeded` AND the goal reads `done`, so that is
  // the predicate, polled through the same GET a human would use.
  const finished = await waitFor('the goal to run itself to completion', async () => {
    const r = await json('GET', '/api/goals/' + goalId, undefined, s.base);
    if (r.status !== 200) return false;
    const g = r.body.goal;
    if (g.status === 'failed') {
      throw new Error(`the goal failed instead of running: ${g.error}`);
    }
    if (g.status !== 'done') return false;
    return r.body;
  }, 60000);

  assert.strictEqual(finished.orders.length, 2, 'the PM shim did not plan two orders');
  for (const o of finished.orders) {
    assert.strictEqual(o.status, 'succeeded',
      `an order did not succeed: ${JSON.stringify(o)}`);
    assert.strictEqual(o.exitCode, 0);
    assert.ok(o.startedAt, 'an order reached a settled status without ever running');
    // Its own worktree, not the user's tree.
    assert.notStrictEqual(o.cwd, project.path, "the agent ran in the user's own tree");
    assert.match(o.cwd, /worktrees/);
    assert.strictEqual(o.goalId, goalId, 'the order lost its goal');
    // Since plan 2d `done` is reachable only through a verdict - so this also
    // proves server.js wired judgeFor.
    assert.strictEqual(o.verdict, 'verified', `an order reached a done goal unjudged: ${JSON.stringify(o)}`);
  }

  // WHO ran them. Every assertion above would also hold if a human had
  // dispatched both by hand, and this file cannot prove a negative about the
  // route - so it asserts the positive instead: the scheduler's own counter
  // says it started them. `started`, not `offered`: offered counts attempts,
  // including ones that were refused or never ran.
  //
  // Waited for rather than read once, because the counter lags the record it
  // describes - see stats() above.
  const counted = await waitFor('the scheduler to count both starts',
    async () => {
      const st = await stats(s.base);
      return st.started >= 2 ? st : false;
    }, 15000);
  assert.strictEqual(counted.errors, 0, `the scheduler logged errors: ${counted.lastError}`);
  await stopServer(s.child);
});

// ------------------------------------------------------------------ ordering

test('the scheduler starts only after the boot reconciles', async () => {
  // ORDERING REQUIREMENT ONE, and it is not stylistic. lib/scheduler's goal
  // sweep derives "is anything in flight" SOLELY from dispatch.isClaimed, never
  // from a record reading `running` - so a stale `running` order left by a
  // killed process is claimed by nobody and counts as neither settled nor in
  // flight. Its goal is written back to `planned`, and a tick that ran BEFORE
  // orders.reconcile() had turned those records into `interrupted` is a tick
  // that reaches exactly that wrong answer.
  //
  // MADE OBSERVABLE RATHER THAN INFERRED, and the cadence is what does it.
  // start() runs its first tick SYNCHRONOUSLY, and both reconciles and the
  // start() call all happen before server.listen() - so by the time this test
  // can send a single request, the correct ordering has already produced its
  // final answer. At a 30 second interval there is no second tick to paper over
  // a wrong first one, so `stalled` and `planned` are the two durable outcomes
  // and the test reads one of them.
  const home = tmp('sched-boothome-');
  const o1 = seedOrder(home, 'running', { prompt: 'crashed one', startedAt: new Date().toISOString() });
  const o2 = seedOrder(home, 'running', { prompt: 'crashed two', startedAt: new Date().toISOString() });
  const goalId = seedGoal(home, 'running', { orderIds: [o1, o2] });

  const s = await startServer(home, { SKILLSPACE_SCHEDULER_INTERVAL_MS: '30000' });

  // The reconciles ran: orders.reconcile settles a crashed `running` order to
  // `interrupted`. Asserted first so a failure below says which half broke.
  assert.strictEqual(readOrder(home, o1).status, 'interrupted');
  assert.strictEqual(readOrder(home, o2).status, 'interrupted');

  // Exactly one tick has fired, so this is the FIRST tick's answer and not a
  // later one correcting it.
  const boot = await stats(s.base);
  assert.strictEqual(boot.ticks, 1,
    `expected exactly the startup tick, got ${boot.ticks} - the interval is too short to prove ordering`);

  // And the startup sweep saw settled orders, so the goal has stopped.
  // `stalled` over `interrupted` orders is plan 2d's meaning: nothing
  // outstanding, nothing judged, a human needed. With start() above the
  // reconciles this still reads `planned` - the sweep saw two records claiming
  // `running` that nothing had claimed, and - the interval being 30s - never
  // looks again.
  const g = await json('GET', '/api/goals/' + goalId, undefined, s.base);
  assert.strictEqual(g.body.goal.status, 'stalled',
    'the startup sweep ran against unreconciled records, so the goal stalled at planned');
  assert.strictEqual(readGoal(home, goalId).status, 'stalled');
  await stopServer(s.child);
});

test('the scheduler is stopped before agents are reaped at SIGTERM', async () => {
  // ORDERING REQUIREMENT TWO. The shutdown handler cancels every running agent
  // and then spins a drain waiting for `closed && agentsRunning() === 0`. That
  // drain is NOT unref'd, so the loop stays alive - and the scheduler's timer,
  // unref'd or not, keeps firing inside it. A scheduler still ticking there
  // sees the orders just cancelled as settled, picks the next queued ones, and
  // spawns FRESH credentialed agents after "cancelling N running agent(s)" has
  // already printed. The count climbs instead of falling, the drain never
  // reaches zero, and the 6 second hatch exits the process from inside
  // runOrder's await, leaving those agents orphaned and their worktrees behind.
  //
  // HOW THE WINDOW IS HELD OPEN, because the first version of this test did not
  // hold it open and BOTH the deleting mutant and the deferring one survived.
  // Without help the window is only the few tens of milliseconds between the
  // cancelled order releasing its slot and the drain's next 50ms poll noticing,
  // and the drain usually won: a green test over a live bug, which is exactly
  // what makes a surviving mutant the test's fault rather than the mutant's.
  //
  // An idle keep-alive socket is what widens it, and server.js's own shutdown
  // block documents why: server.close() does not close one, so `closed` stays
  // false and the drain keeps spinning. That is not a contrivance, it is THE
  // production case - the console is a browser polling this very endpoint over
  // a kept-alive connection, so a real ^C lands with the window wide open.
  //
  // VERIFIED THE WAY 825b02d WAS: with pgrep, on the AGENT. "The server exited"
  // is not the claim - a detached agent survives the process that spawned it,
  // which is the entire reason that commit exists. The RECORD is checked first
  // at each point, because runOrder writes markRunning before it spawns, so
  // `queued` with a null startedAt already proves no agent existed; the process
  // check is what proves none SURVIVED, which the record cannot say.
  //
  // KNOWN LIMIT, recorded because it is unexplained rather than because it is
  // understood: one run of this assertion failed under a pair of concurrent
  // full-suite runs, reporting a process count of 1 after the server had
  // already exited. It has not recurred in ~50 further halves, including
  // deliberate CPU-load and paired-file runs, and the two measurement causes
  // that could produce it were tested and ruled out (pgrep matching its own
  // shell wrapper: 0/300 under load; the record, which is the deterministic
  // observable, was not captured at the time). What changed since is diagnosis,
  // not a fix: the count now comes from execFileSync with no shell in the way,
  // the record is asserted first and separately, and a failure prints the
  // matching command lines. If it recurs, the message will say what matched.
  const home = tmp('sched-shutdownhome-');
  const s = await startServer(home, {
    // The floor lib/scheduler accepts. The mutant needs a tick inside the
    // window; the correct code needs none, so a fast cadence cannot make this
    // pass for the wrong reason.
    SKILLSPACE_SCHEDULER_INTERVAL_MS: '10',
    // ONE slot, so the scheduler runs the first order and leaves the second
    // queued. The second is the one that must never start.
    SKILLSPACE_MAX_RUNS: '1',
  });
  const project = await makeGitProject(s.base);

  const first = newMark('FIRST');
  const second = newMark('SECOND');
  // Oldest-first, so the first seeded is the one that runs. If that ever stops
  // holding, the wait below times out and says so rather than passing quietly.
  const idA = seedOrder(home, 'queued', { projectId: project.id, prompt: `${SLOW_MARK} ${first}` });
  const idB = seedOrder(home, 'queued', { projectId: project.id, prompt: `${SLOW_MARK} ${second}` });

  await waitFor('the scheduler to put an agent on the first order',
    async () => aliveCount(first) > 0, 30000);
  assert.strictEqual(aliveCount(second), 0,
    'the ceiling did not hold, so both orders were already running and this proves nothing');

  const held = await holdActiveRequest(s.port);
  try {
    s.child.kill('SIGTERM');

    // Watch the whole window rather than sampling its end: a mutant's agent can
    // be spawned and then orphaned, and either way it must never exist at all.
    const until = Date.now() + 2000;
    let sawWindow = false;
    while (Date.now() < until) {
      // THE RECORD FIRST, because it is the deterministic half. runOrder writes
      // markRunning BEFORE it spawns, so a second order still reading `queued`
      // with a null startedAt proves no agent was ever started for it -
      // independently of what any process table says.
      assert.strictEqual(readOrder(home, idB).status, 'queued',
        'the scheduler started the second order after shutdown began');
      assert.strictEqual(aliveCount(second), 0,
        `the scheduler dispatched a fresh agent into a shutting-down server: ${whatMatched(second)}`);
      // The window this test needs must actually BE open. If the server had
      // already exited, every check above would be vacuous - which is the way
      // the first version of this test fooled itself.
      if (s.child.exitCode === null) sawWindow = true;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(sawWindow,
      'the server exited immediately, so nothing here was ever given a chance to fail');
    assert.strictEqual(s.child.exitCode, null,
      'the drain did not stay open, so the window this test measures did not exist');
  } finally {
    held.destroy();
  }

  await waitFor('the server to exit once the socket is gone',
    async () => s.child.exitCode !== null, 15000);

  // Again, record first: an agent whose worktree was still being prepared when
  // the window closed would show up here and not there, and the record is what
  // says so without depending on the process table.
  const recB = readOrder(home, idB);
  assert.strictEqual(recB.status, 'queued',
    `the second order was started after shutdown began: ${JSON.stringify(recB)}`);
  assert.strictEqual(recB.startedAt, null, 'the second order reached an agent');
  assert.strictEqual(aliveCount(second), 0,
    `an agent for the second order outlived the server: ${whatMatched(second)}`);

  // The first agent is dead, not merely unobserved, and its outcome is on disk.
  await waitFor('the cancelled agent to die', async () => aliveCount(first) === 0, 15000);
  assert.strictEqual(readOrder(home, idA).status, 'cancelled',
    'the server exited before the cancelled order recorded its outcome');
});

test('an order the scheduler started holds the shutdown drain open', async () => {
  // The drain waits on agentsRunning(), which sums /api/run's children,
  // lib/plan's PMs and dispatch's orders. An order the SCHEDULER started has to
  // land in that third pool like any other - it goes through dispatch.runOrder,
  // and this is what says so from the outside. If it did not, the server would
  // exit on server.close alone, measured at ~4ms, and the record would still
  // read `running` for the next boot's reconcile to guess at.
  //
  // The observable is the RECORD, not the exit code: runOrder deletes from
  // inFlight in a `finally`, which runs after the return expression that writes
  // the outcome, so a count that reached zero means the outcome is on disk.
  // `cancelled` on disk is therefore the proof that the drain waited.
  const home = tmp('sched-drainhome-');
  const s = await startServer(home, { SKILLSPACE_SCHEDULER_INTERVAL_MS: '50' });
  const project = await makeGitProject(s.base);

  const mark = newMark('DRAIN');
  const id = seedOrder(home, 'queued', { projectId: project.id, prompt: `${SLOW_MARK} ${mark}` });

  await waitFor('the scheduler to put an agent on the order', async () => aliveCount(mark) > 0);
  // The record must actually be running before SIGTERM, or "it was cancelled"
  // could mean the order never started at all.
  await waitFor('the order to read running', async () =>
    readOrder(home, id).status === 'running');

  s.child.kill('SIGTERM');
  await new Promise((r) => s.child.on('exit', r));

  assert.strictEqual(readOrder(home, id).status, 'cancelled',
    'the server exited before the order the scheduler started recorded its outcome');
  await waitFor(`the agent to die (${whatMatched(mark)})`,
    async () => aliveCount(mark) === 0, 15000);
});

// ------------------------------------------------------------------ agentFor

test('the scheduler runs the agent an order names, and refuses one it cannot resolve',
  async () => {
    // agentFor is server.js's to supply - lib/scheduler requires it and refuses
    // to invent one, because picking a default would run a human's prompt
    // through a tool they did not choose. It resolves through the SAME
    // routes/common.js function both agent-spawning routes use, and this pins
    // the two halves of that rule which a hand-written version gets wrong.
    //
    // HALF ONE: a named agent is honoured. With one shim installed, an agentFor
    // that ignores the record and always hands back AGENTS[0] passes anyway,
    // because the two would be the same binary - hence two shims, and `codex`
    // being the one that can only be reached by being named.
    //
    // HALF TWO: a name it cannot resolve is REFUSED, not silently replaced with
    // AGENTS[0]. routes/common.js records this as a defect the route layer
    // already had to fix once: reading {"agent": 5} as ABSENT and handing back
    // AGENTS[0]. `body.agent || ''` is only a partial patch - 0, false and NaN
    // still fall through - so the case tested is PRESENCE, not truthiness.
    //
    // Reachable today only through a hand-edited record: lib/orders writes
    // `agent` at markRunning, so a `queued` order carries null in ordinary
    // operation. That is a reason this is defensive, not a reason it is
    // unnecessary - a record is a file on disk, and the fail-closed direction
    // for "an agent I do not recognise" is to leave the order queued rather
    // than to run it on something else.
    const home = tmp('sched-agenthome-');
    const s = await startServer(home, {
      SKILLSPACE_SCHEDULER_INTERVAL_MS: '100',
      SKILLSPACE_MAX_RUNS: '8',
    });
    const project = await makeGitProject(s.base);

    // Seeded oldest-first, so the two unrunnable ones are considered BEFORE the
    // one that must run: a scheduler that abandoned the tick on the first bad
    // candidate would then leave the control queued too.
    const nonString = seedOrder(home, 'queued',
      { projectId: project.id, agent: 5, prompt: 'a number is not an agent id' });
    const unknown = seedOrder(home, 'queued',
      { projectId: project.id, agent: 'nope', prompt: 'no such agent' });
    const named = seedOrder(home, 'queued',
      { projectId: project.id, agent: 'codex', prompt: 'run me on codex' });

    const ran = await waitFor('the order naming codex to settle', async () => {
      const rec = readOrder(home, named);
      return rec.status === 'succeeded' ? rec : false;
    }, 60000);
    assert.strictEqual(ran.agent, 'codex',
      'the order was run on AGENTS[0] instead of the agent it named');

    // Wait for the COUNTER, not the record: `started` is incremented in a
    // .then() that runs after `succeeded` is already on disk, so asserting on
    // it here would be reading it one microtask early.
    const after = await waitFor('the scheduler to count the start',
      async () => {
        const st = await stats(s.base);
        return st.started >= 1 ? st : false;
      }, 30000);

    // Then several more ticks, counted FROM THAT MOMENT rather than from zero:
    // an absolute threshold is one the control order's own runtime may already
    // have passed, which would make "still queued" an answer the poll simply
    // arrived ahead of rather than a durable one.
    await waitFor('five more ticks with nothing left to do', async () => {
      const st = await stats(s.base);
      return st.ticks >= after.ticks + 5;
    }, 30000);

    for (const [id, why] of [[nonString, 'a non-string agent'], [unknown, 'an unknown agent']]) {
      const rec = readOrder(home, id);
      // QUEUED, and specifically not `failed`. dispatch.runOrder answers an
      // absent agent with markFailed - which is SETTLED and never retried - so
      // a scheduler that passed the refusal through to runOrder would burn the
      // record permanently on a value a human can fix by editing one field.
      assert.strictEqual(rec.status, 'queued',
        `${why} did not leave the order queued: ${JSON.stringify(rec)}`);
      assert.strictEqual(rec.startedAt, null, `${why} was run anyway`);
    }

    // Never even OFFERED to runOrder: exactly one of the three reached it.
    const st = await stats(s.base);
    assert.strictEqual(st.started, 1, `expected one start, got ${st.started}`);
    assert.strictEqual(st.offered, 1,
      `an unrunnable order was handed to runOrder anyway (offered=${st.offered})`);
    await stopServer(s.child);
  });

// ------------------------------------------- the switch, and the door it keeps

test('SKILLSPACE_SCHEDULER=0 leaves the loop unstarted and the orders queued', async () => {
  // THE SWITCH IS THE PREMISE OF TWO OTHER TEST FILES. test/orders-api.test.js
  // and test/goals-api.test.js both set it, because both test the human
  // dispatch door and a loop running underneath them would be racing their
  // fixtures. Until this test existed, `if (process.env.SKILLSPACE_SCHEDULER
  // === '0')` could be replaced with `if (false)` - the switch ignored, the
  // scheduler always started - and all three files still passed: 27/27, 37/37
  // and 8/8. The protection those two rigs claim was unverified.
  //
  // It is also a user-facing mode in its own right, and the argument for
  // turning the loop on by default rests on it: the scheduler makes dispatching
  // by hand optional rather than removing it, and this is where a user who
  // wants to read each order before it runs gets that back.
  //
  // BOTH HALVES, because the flag readback alone is the weaker one: a build
  // that reported `running: false` while quietly dispatching would pass it.
  const home = tmp('sched-offhome-');
  const s = await startServer(home, {
    SKILLSPACE_SCHEDULER: '0',
    // Honoured, the interval is never read. Ignored, this is what makes the
    // mutant take the order in tens of milliseconds instead of one second.
    SKILLSPACE_SCHEDULER_INTERVAL_MS: '50',
  });
  const project = await makeGitProject(s.base);

  const off = await stats(s.base);
  assert.strictEqual(off.running, false, 'the switch was ignored and the scheduler started');
  assert.strictEqual(off.ticks, 0, 'the scheduler ticked with the switch off');
  assert.strictEqual(off.startedAt, null, 'start() ran with the switch off');
  assert.strictEqual(off.intervalMs, null, 'a cadence was configured with the switch off');

  // And nothing runs. A queued order on a working project, left alone for
  // thirty of the mutant's ticks.
  const id = seedOrder(home, 'queued', { projectId: project.id, prompt: 'must not run itself' });
  await new Promise((r) => setTimeout(r, 1500));
  const rec = readOrder(home, id);
  assert.strictEqual(rec.status, 'queued',
    `something dispatched an order with the scheduler off: ${JSON.stringify(rec)}`);
  assert.strictEqual(rec.startedAt, null, 'an agent ran with the scheduler off');

  // The door itself is still open in this mode - that is the whole point of
  // having one - so the same order dispatches by hand.
  const d = await json('POST', `/api/orders/${id}/dispatch`, undefined, s.base);
  assert.strictEqual(d.status, 200, JSON.stringify(d.body));
  await waitFor('the hand-dispatched order to settle', async () =>
    readOrder(home, id).status === 'succeeded');
  await stopServer(s.child);
});

test('a human can still dispatch by id with the loop running', async () => {
  // "The door is still open" was prose until this test. Every other test that
  // touches POST /api/orders/:id/dispatch runs with SKILLSPACE_SCHEDULER=0, so
  // the route had no coverage at all in the configuration users actually run.
  //
  // AT THE SHIPPED CADENCE, asserted rather than configured: no interval is
  // passed, and intervalMs is checked to be lib/scheduler's own default. A test
  // that quietly slowed the loop down would be measuring a race that does not
  // exist in the product.
  //
  // WHICH AGENT DISCRIMINATES, which is why this file installs two shims. The
  // route is asked for `codex`; agentFor reads the record's `agent`, which is
  // null on a queued order, so the LOOP would run it on AGENTS[0] - `claude`.
  // The agent on the settled record therefore says who dispatched it, with no
  // need to prove a negative about the route.
  //
  // DETERMINISM COMES FROM TICK PHASE, not from hoping. The window between
  // writing the record and the route's synchronous claim is a few milliseconds;
  // the tick period is a thousand. Syncing to just after a tick leaves ~970ms
  // of margin rather than an unknown slice of one. Measured without the sync:
  // the route won 60 of 60 anyway, which is a 0.3% flake left on the table for
  // no reason.
  const cadenced = await stats(schedBase);
  assert.strictEqual(cadenced.intervalMs, 1000,
    'this server is not running at the shipped cadence, so the race it measures is not the real one');
  assert.strictEqual(cadenced.running, true, 'the loop is not running, so the door is not being contested');

  const before = await waitFor('a tick, so the next one is a full period away', async () => {
    const now = await stats(schedBase);
    return now.ticks > cadenced.ticks ? now : false;
  }, 10000);

  const id = seedOrder(schedHome, 'queued',
    { projectId: schedProject.id, prompt: 'dispatched by a human' });
  const d = await json('POST', `/api/orders/${id}/dispatch`, { agent: 'codex' }, schedBase);
  assert.strictEqual(d.status, 200,
    `the route refused a queued order with the loop running: ${JSON.stringify(d.body)}`);

  const rec = await waitFor('the hand-dispatched order to settle', async () => {
    const r = readOrder(schedHome, id);
    return r.status === 'succeeded' ? r : false;
  }, 30000);
  assert.strictEqual(rec.agent, 'codex',
    'the loop ran the order instead of the route, so the agent the request named was ignored');
  assert.strictEqual(rec.exitCode, 0);

  // And the loop did not also run it. `started` counts only the loop's starts,
  // so an unchanged counter is the second half of the same claim.
  const after = await stats(schedBase);
  assert.strictEqual(after.started, before.started,
    'the scheduler started an order the route had already claimed');
});

test('an order left queued is taken by the loop, and dispatch by id then refuses', async () => {
  // THE OTHER HALF OF THE SAME RACE, and it is a product finding rather than a
  // test that needed tuning. The test above wins because it dispatches within
  // milliseconds of the record appearing. An order that has been SITTING queued
  // - which is what every order a PM plans actually is - has been claimed by
  // the loop within one tick, and by the time a human clicks anything the route
  // can only refuse.
  //
  // Measured at the shipped 1000ms cadence, seeding and then waiting out one
  // tick: 25 of 25 came back 409 "order is already succeeded", every one having
  // run on AGENTS[0]. Not 0 of 25, not sometimes - the loop wins that one
  // outright.
  //
  // WHAT IS AND IS NOT LOST. The order runs, exactly once, and the route
  // refuses rather than putting a second agent on a record another dispatch
  // owns - which is the invariant runOrder is built around and the only thing
  // here that would be a bug. What IS unreachable is the route's `agent`
  // OVERRIDE for a pre-existing queued order: with the loop on, choosing the
  // agent for a planned order means winning a race a human cannot see. Worth
  // knowing before the console grows a button for it; recorded here rather than
  // asserted away.
  const id = seedOrder(schedHome, 'queued',
    { projectId: schedProject.id, prompt: 'left for the loop' });

  const ran = await waitFor('the loop to run the order nobody dispatched', async () => {
    const r = readOrder(schedHome, id);
    return r.status === 'succeeded' ? r : false;
  }, 30000);
  assert.strictEqual(ran.agent, 'claude',
    'the loop did not run it on AGENTS[0], so agentFor is reading something it should not');

  const d = await json('POST', `/api/orders/${id}/dispatch`, { agent: 'codex' }, schedBase);
  assert.strictEqual(d.status, 409,
    `the route accepted an order the loop had already run: ${JSON.stringify(d.body)}`);
  assert.match(d.body.error, /already (being dispatched|running|succeeded)/);

  // Exactly once, and on the agent that actually ran it. A second dispatch that
  // had gone through would have overwritten this.
  const after = readOrder(schedHome, id);
  assert.strictEqual(after.status, 'succeeded');
  assert.strictEqual(after.agent, 'claude');
  assert.strictEqual(after.exitCode, 0);
});

// ------------------------------------------------------------------ the hold (plan 3, Task 0)

test('a goal posted with hold:true waits for release, and says why', async () => {
  // Over the wire, with the loop running: the review window the spec asks for.
  // Mutant: the scheduler's held check removed - both orders run within a
  // tick of the plan landing and the first assertion fails.
  const home = tmp('sched-holdhome-');
  const s = await startServer(home, {
    SKILLSPACE_SCHEDULER_INTERVAL_MS: '100',
    SKILLSPACE_MAX_RUNS: '8',
  });
  try {
    const project = await makeGitProject(s.base);
    const posted = await json('POST', '/api/goals', { projectId: project.id, text: 'read me first', hold: true }, s.base);
    assert.strictEqual(posted.status, 200, JSON.stringify(posted.body));
    const goalId = posted.body.goal.id;
    const planned = await waitFor('the plan to land', async () => {
      const r = await json('GET', '/api/goals/' + goalId, undefined, s.base);
      return r.body.goal.status === 'planned' ? r.body : false;
    });
    assert.strictEqual(planned.orders.length, 2);

    // Ten ticks' worth of chances to be wrong.
    const t0 = (await stats(s.base)).ticks;
    await waitFor('ten ticks', async () => (await stats(s.base)).ticks >= t0 + 10);
    const still = await json('GET', '/api/goals/' + goalId, undefined, s.base);
    assert.deepStrictEqual(still.body.orders.map((o) => o.status), ['queued', 'queued'],
      'a held goal\'s orders ran');
    const st = await stats(s.base);
    assert.strictEqual(st.lastSkip && st.lastSkip.reason, 'goal held for review');
    assert.ok(Array.isArray(st.pausedProjectIds), 'pausedProjectIds is missing from the route');

    const rel = await json('POST', `/api/goals/${goalId}/release`, undefined, s.base);
    assert.strictEqual(rel.status, 200, JSON.stringify(rel.body));
    await waitFor('the released goal to run to done', async () => {
      const r = await json('GET', '/api/goals/' + goalId, undefined, s.base);
      return r.body.goal.status === 'done';
    }, 60000);
    assert.strictEqual((await json('POST', `/api/goals/${goalId}/release`, undefined, s.base)).status, 409,
      'a done goal was released a second time');
  } finally {
    await stopServer(s.child);
  }
});
