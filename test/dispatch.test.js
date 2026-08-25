'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const dispatch = require('../lib/dispatch');
const orders = require('../lib/orders');
const projects = require('../lib/projects');
const worktrees = require('../lib/worktrees');

const created = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'skillspace-dsp-'));
  created.push(d);
  return d;
}
function tmpGitRepo() {
  const d = tmpDir('skillspace-dsprepo-');
  execSync('git init -q', { cwd: d });
  fs.writeFileSync(path.join(d, 'file.txt'), 'original\n');
  execSync('git add -A', { cwd: d });
  execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: d });
  return d;
}
function shimAgent(script) {
  const dir = tmpDir('skillspace-shim-');
  const bin = path.join(dir, 'fake-agent');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return { id: 'fake', bin, buildArgs: (p) => ['-p', p] };
}
after(() => {
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

const OK = '#!/bin/sh\necho "did the work"\nexit 0\n';
const BAD = '#!/bin/sh\necho "broke"\nexit 4\n';
const SLOW = '#!/bin/sh\nsleep 60\n';

test('a dispatched order runs isolated, succeeds, and is recorded', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'do it' });

  const result = await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });

  assert.strictEqual(result.status, 'succeeded');
  const stored = orders.get(root, order.id);
  assert.strictEqual(stored.status, 'succeeded');
  assert.strictEqual(stored.exitCode, 0);
  assert.strictEqual(stored.agent, 'fake');
  assert.ok(stored.startedAt && stored.finishedAt);
  assert.match(fs.readFileSync(path.join(root, 'logs', `${order.id}.log`), 'utf8'), /did the work/);
});

test('the worktree is removed after the order finishes', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });
  const wtRoot = path.join(root, 'worktrees');
  const left = fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [];
  assert.deepStrictEqual(left, [], `worktree left behind: ${JSON.stringify(left)}`);
});

test('the agent\'s work survives on the order branch', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  const agent = shimAgent('#!/bin/sh\necho "output" > agent-made.txt\nexit 0\n');

  await dispatch.runOrder(root, { order, project, agent });

  const files = execSync(`git ls-tree -r --name-only skillspace/${order.id}`, { cwd: repo, encoding: 'utf8' });
  assert.match(files, /agent-made\.txt/, 'the agent\'s work was discarded');
});

test('a non-zero exit records failed with the exit code, and still cleans up', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  await dispatch.runOrder(root, { order, project, agent: shimAgent(BAD) });

  const stored = orders.get(root, order.id);
  assert.strictEqual(stored.status, 'failed');
  assert.strictEqual(stored.exitCode, 4);
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], [],
    'a failed run must not hold its worktree');
});

test('a worktree that cannot be created fails the order before any agent starts', async () => {
  // The shim would exit 0 if it ever ran, so a succeeded status here would
  // prove the abort did not happen.
  const root = tmpDir('skillspace-home-');
  const notARepo = tmpDir('skillspace-plain-');
  const project = { ...projects.create(root, { path: notARepo }), kind: 'git' };
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  // The prepare-failure path must not enter the cleanup scope at all: there is
  // no worktree to clean, and entering it would hand cleanup an undefined wt.
  // Harmless today only because cleanup guards its own argument - this asserts
  // the nesting rather than leaning on that guard. (Assumes no concurrent
  // dispatch; top-level tests run sequentially.)
  const realCleanup = worktrees.cleanup;
  const cleanupCalls = [];
  worktrees.cleanup = (wt) => { cleanupCalls.push(wt); return realCleanup(wt); };
  let result;
  try {
    result = await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });
  } finally {
    worktrees.cleanup = realCleanup;
  }

  assert.strictEqual(result.status, 'failed');
  assert.deepStrictEqual(cleanupCalls, [],
    'the prepare-failure path entered the cleanup scope with no worktree');
  const stored = orders.get(root, order.id);
  assert.match(stored.error, /worktree/);
  assert.strictEqual(stored.startedAt, null, 'no agent should have started');
});

test('maxOrdersPerDay refuses a dispatch and does not spawn or prepare', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const base = projects.create(root, { path: repo });
  const project = { ...base, budget: { ...base.budget, maxOrdersPerDay: 1 } };

  const first = orders.create(root, { projectId: project.id, prompt: 'one' });
  const firstResult = await dispatch.runOrder(root, { order: first, project, agent: shimAgent(OK) });
  // A cap of N runs N, not N-1: the dispatched order is already inside its own
  // countToday, which is the only reason `>` rather than `>=` is correct.
  assert.strictEqual(firstResult.status, 'succeeded', 'a cap of 1 must still run 1 order');

  const second = orders.create(root, { projectId: project.id, prompt: 'two' });
  const result = await dispatch.runOrder(root, { order: second, project, agent: shimAgent(OK) });

  assert.strictEqual(result.status, 'failed');
  assert.match(orders.get(root, second.id).error, /daily limit/);
  assert.strictEqual(orders.get(root, second.id).startedAt, null);
  // Refused BEFORE a worktree exists, so a refused order leaves nothing behind.
  // An empty worktrees/ is NOT enough on its own - it is equally true of a
  // worktree that was created and then cleaned up. The durable trace is the
  // branch, which cleanup deliberately keeps. Scoped to the second order's id:
  // the first order ran legitimately and its skillspace/ branch is meant to
  // survive, so a blanket "no skillspace/ branches" check would fail here on
  // correct code.
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], [],
    'the budget check ran after the worktree was created');
  const branches = execSync('git branch --list', { cwd: repo, encoding: 'utf8' });
  assert.ok(!branches.includes(second.id),
    'a refused order prepared a worktree it should never have created');
});

test('the order timeout comes from the project budget', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const base = projects.create(root, { path: repo });
  const project = { ...base, budget: { ...base.budget, orderTimeoutMs: 700 } };
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  const started = Date.now();
  await dispatch.runOrder(root, { order, project, agent: shimAgent(SLOW) });
  const elapsed = Date.now() - started;

  const stored = orders.get(root, order.id);
  assert.strictEqual(stored.status, 'failed');
  assert.strictEqual(stored.error, 'timeout');
  assert.strictEqual(stored.exitCode, null);
  // The shim sleeps 60s, so ANY bound under 60s produces this same outcome -
  // status alone cannot tell 700ms from a hardcoded 5000 or from 3x the
  // budget. Elapsed time is what ties the run to the project's own number.
  //
  // Bracketed both ways: the lower bound catches a bound SMALLER than the
  // budget, the upper one a larger. 1800 rather than a rounder 3000 because a
  // 3x mutant lands at ~2195ms and would sail under it. Correct code measured
  // 777-795ms over five runs, so the upper bound carries ~2.3x headroom and
  // still leaves ~400ms of daylight below the nearest surviving mutant.
  assert.ok(elapsed >= 700,
    `the run took ${elapsed}ms - shorter than the project's own 700ms budget`);
  assert.ok(elapsed < 1800,
    `the run took ${elapsed}ms - the project's 700ms budget was not used`);
});

test('a dir project runs in place and the directory survives', async () => {
  const root = tmpDir('skillspace-home-');
  const work = tmpDir('skillspace-work-');
  fs.writeFileSync(path.join(work, 'keep.txt'), 'precious');
  const project = projects.create(root, { path: work });
  assert.strictEqual(project.kind, 'dir');
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  // Watch what dispatch hands cleanup. A dir project marked isolated:true would
  // take cleanup's destructive path over the user's own directory; today that
  // is caught only by cleanup's own guard, nothing in dispatch.
  // Assumes no other dispatch is in flight: `seen` is asserted exactly, against
  // a module-global stub, so a concurrent runOrder would append and fail this
  // spuriously. True today because top-level tests run sequentially.
  const realCleanup = worktrees.cleanup;
  const seen = [];
  worktrees.cleanup = (wt) => { seen.push(wt && wt.isolated); return realCleanup(wt); };
  try {
    await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });
  } finally {
    worktrees.cleanup = realCleanup;
  }
  assert.deepStrictEqual(seen, [false],
    'cleanup was handed a dir project as isolated');

  assert.strictEqual(orders.get(root, order.id).cwd, fs.realpathSync(work));
  assert.ok(fs.existsSync(path.join(work, 'keep.txt')), 'a dir project must never be cleaned up');
  assert.ok(fs.existsSync(work));
});

test('cancel stops a running order and records cancelled', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  const running = dispatch.runOrder(root, { order, project, agent: shimAgent(SLOW) });
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(dispatch.cancel(order.id), true);
  const result = await running;

  assert.strictEqual(result.status, 'cancelled');
  assert.strictEqual(orders.get(root, order.id).status, 'cancelled');
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], [],
    'a cancelled order must not hold its worktree');
});

test('cancel of an unknown or finished order reports false', async () => {
  assert.strictEqual(dispatch.cancel('ord-nope'), false);
});

test('a missing agent fails the order without preparing a worktree', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  const result = await dispatch.runOrder(root, { order, project, agent: null });

  assert.strictEqual(result.status, 'failed');
  assert.match(orders.get(root, order.id).error, /agent/);
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], []);
  // Nothing ran, so unlike the budget test there is no legitimate branch here
  // and the blanket check is the stronger one.
  const branches = execSync('git branch --list', { cwd: repo, encoding: 'utf8' });
  assert.ok(!branches.includes('skillspace/'),
    'a refused order prepared a worktree it should never have created');
});

test('a throw while starting the agent settles the order, never leaves it running', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  // logs/ as a regular file: runner.start's mkdirSync throws EEXIST.
  fs.writeFileSync(path.join(root, 'logs'), 'not a directory');

  const result = await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });

  assert.strictEqual(result.status, 'failed');
  assert.match(orders.get(root, order.id).error, /dispatch:/);
  assert.notStrictEqual(orders.get(root, order.id).status, 'running',
    'a throw left the order live with no process behind it');
  // markFailed would force startedAt back to null, erasing that this order got
  // as far as being marked running. markFinished is the correct verb.
  assert.ok(orders.get(root, order.id).startedAt,
    'startedAt was erased; this order did start');
});

test('a second dispatch of the same order is refused', async () => {
  const root = tmpDir('skillspace-home-');
  // A dir project is the case with no natural interlock: prepare cannot fail,
  // so without a guard both agents run in the user's own directory.
  const work = tmpDir('skillspace-work-');
  const project = projects.create(root, { path: work });
  assert.strictEqual(project.kind, 'dir');
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  const tally = path.join(tmpDir('skillspace-tally-'), 'runs.txt');
  const agent = shimAgent(`#!/bin/sh\nsleep 1\necho ran >> ${tally}\nexit 0\n`);

  await Promise.all([
    dispatch.runOrder(root, { order, project, agent }),
    dispatch.runOrder(root, { order, project, agent }),
  ]);

  const ran = fs.existsSync(tally)
    ? fs.readFileSync(tally, 'utf8').split('\n').filter(Boolean)
    : [];
  assert.strictEqual(ran.length, 1,
    `the agent ran ${ran.length} times in the user's own directory`);
});

test('cancelling during worktree preparation does not spawn an agent', async () => {
  // dispatch.cancel cannot reach an order that is still preparing - there is no
  // handle yet - so the route settles the record itself. Without an intent
  // check, prepare finishes, markRunning silently no-ops through patch()'s
  // settled guard, and an agent starts that the API then refuses to cancel
  // (409, already settled): unlisted, unsupervised, and surviving a server kill.
  //
  // A git project is the case with a real window: `git worktree add` takes tens
  // of milliseconds even on this two-file fixture (33-40ms measured), and
  // seconds on a real repository. The test does not depend on that margin
  // though - runOrder runs synchronously up to `await worktrees.prepare`, so
  // marking the record on the next line is inside the window by construction,
  // with no tick needed. Do not add an await above it and start relying on the
  // duration instead.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  assert.strictEqual(project.kind, 'git');
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  const marker = path.join(tmpDir('skillspace-mark-'), 'spawned.txt');
  const agent = shimAgent(`#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`);

  const running = dispatch.runOrder(root, { order, project, agent });
  assert.strictEqual(dispatch.cancel(order.id), false,
    'the premise is that cancel cannot reach an order still preparing');
  orders.markCancelled(root, order.id);   // what the route does in this window
  await running;

  assert.ok(!fs.existsSync(marker), 'an agent was spawned for an order already cancelled');
  assert.strictEqual(orders.get(root, order.id).status, 'cancelled');
  // This path returns before the try/finally that normally releases the claim,
  // so it has to release its own. server.js gates graceful shutdown on
  // inFlightCount() === 0; a leak here makes every shutdown wait out the hatch.
  assert.strictEqual(dispatch.inFlightCount(), 0, 'the intent-check path leaked its slot');

  // and the abandoned worktree is not left holding the branch
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], [],
    'the worktree survived an order that never ran');
});

test('a refused duplicate dispatch is distinguishable from a successful one', async () => {
  const root = tmpDir('skillspace-home-');
  const work = tmpDir('skillspace-work-');        // dir project: no interlock
  const project = projects.create(root, { path: work });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  const agent = shimAgent(SLOW);

  const first = dispatch.runOrder(root, { order, project, agent });
  await new Promise((r) => setTimeout(r, 200));
  const second = await dispatch.runOrder(root, { order, project, agent });

  assert.ok(second.refused, 'a refusal must be visible to the caller');
  assert.ok(dispatch.cancel(order.id));
  await first;
});

test('a worktree failure releases the slot', async () => {
  // Otherwise the Map grows forever and that order id is permanently
  // undispatchable - the same leak the prepare catch was written to avoid.
  const root = tmpDir('skillspace-home-');
  const notARepo = tmpDir('skillspace-plain-');
  const project = { ...projects.create(root, { path: notARepo }), kind: 'git' };
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  const first = await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });
  assert.strictEqual(first.status, 'failed');
  const second = await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });
  assert.ok(!second.refused, 'the slot was never released');
});

test('the slot is claimed before any await, so a running order stays cancellable', async () => {
  // Claiming after the first await lets a second dispatch overwrite the first's
  // handle: the running agent then has no reachable handle and cancel() returns
  // false. The intent check prevents the second SPAWN, so an agent-count
  // assertion no longer catches this - the cancellability is the property.
  const root = tmpDir('skillspace-home-');
  const work = tmpDir('skillspace-work-');        // dir: no worktree interlock
  const project = projects.create(root, { path: work });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  const agent = shimAgent(SLOW);

  // The second dispatch is issued SYNCHRONOUSLY, with no tick in between. That
  // is the whole point: runOrder runs synchronously only as far as its first
  // await, so a claim staked before that await is already visible here, while
  // one staked after prepare resolves is not. Sleeping first would let a late
  // claim settle and the mutant would sail through.
  const first = dispatch.runOrder(root, { order, project, agent });
  const second = await dispatch.runOrder(root, { order, project, agent });

  assert.strictEqual(second.refused, 'already dispatched');

  // Only now let the first reach `running`, and check its handle is the one
  // cancel() finds - a second dispatch that got through would have overwritten it.
  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual(dispatch.cancel(order.id), true, 'the running agent became unreachable');
  assert.strictEqual((await first).status, 'cancelled');
});

test('an order that settles as failed during preparation does not spawn either', async () => {
  // The intent check must test for "still queued", not for "cancelled". A
  // record can settle mid-prepare as failed or interrupted too - reconcile()
  // writes `interrupted` on boot, and the route can fail an order outright -
  // and every one of those means nobody is waiting for an agent any more.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  const marker = path.join(tmpDir('skillspace-mark-'), 'spawned.txt');
  const agent = shimAgent(`#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`);

  const running = dispatch.runOrder(root, { order, project, agent });
  orders.markFailed(root, order.id, 'settled by something else mid-prepare');
  await running;

  assert.ok(!fs.existsSync(marker), 'an agent was spawned for an order already settled as failed');
  assert.strictEqual(orders.get(root, order.id).status, 'failed');
  assert.strictEqual(dispatch.inFlightCount(), 0, 'the intent-check path leaked its slot');
});

test('a store failure while marking the order running leaks nothing', async () => {
  // markRunning sat between the inFlight claim and the try/finally that
  // released it - the only statement in that gap. A store write failing there
  // leaked the slot permanently (that order id undispatchable forever), leaked
  // the worktree and its branch, and left the record queued.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  // Readable so get()/countToday() still work; unwritable so writeJson throws.
  fs.chmodSync(path.join(root, 'orders'), 0o555);
  try {
    await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) }).catch(() => {});
  } finally {
    fs.chmodSync(path.join(root, 'orders'), 0o755);
  }

  assert.strictEqual(dispatch.inFlightCount(), 0, 'the slot leaked permanently');
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], [],
    'the worktree leaked');
});
