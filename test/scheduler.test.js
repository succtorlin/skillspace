'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const scheduler = require('../lib/scheduler');
const dispatch = require('../lib/dispatch');
const orders = require('../lib/orders');
const goals = require('../lib/goals');
const projects = require('../lib/projects');
const store = require('../lib/store');

// Harness modelled on test/dispatch.test.js, helper for helper. They are
// file-local there, so this is a copy rather than an import - but a copy that
// has to keep answering the same way, because the scheduler's whole job is
// driving the module those helpers were built for.
const created = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'skillspace-sch-'));
  created.push(d);
  return d;
}
function tmpGitRepo() {
  const d = tmpDir('skillspace-schrepo-');
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

// The scheduler requires an explicit child-environment policy rather than
// defaulting to process.env, so every call site supplies one. Minimal on
// purpose: the shims are /bin/sh scripts calling sleep and echo.
const testEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME });

// Poll an observable rather than sleeping a guessed interval, for the reason
// test/dispatch.test.js gives: a fixed sleep encodes a warm-machine timing that
// does not hold under contention. Fails loudly on timeout.
async function waitFor(what, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Let a fixed number of ticks elapse. Used only for NEGATIVE assertions -
// "this never happened" - where there is no observable to poll for and the
// honest alternative is to give the loop enough chances to be wrong.
async function ticksPass(n, intervalMs) {
  const target = scheduler.stats().ticks + n;
  await waitFor(`${n} ticks`, () => scheduler.stats().ticks >= target, 5000 + n * intervalMs * 4);
}

function pidsIn(file) {
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    : [];
}

// VERIFIED WITH ps, not with kill -0: this suite has seen kill -0 report a
// process dead while ps showed it at 100% CPU. ps exits non-zero when none of
// the listed pids exist, which is the empty answer, not an error.
function aliveCount(pids) {
  if (pids.length === 0) return 0;
  try {
    const out = execFileSync('ps', ['-o', 'pid=', '-p', pids.join(',')], { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.trim()).length;
  } catch (_) {
    return 0;
  }
}

// Every test that starts the loop must come back through here, in a finally.
// dispatch's in-flight map and its capacity predicate are process-wide
// singletons shared by every test in this file, so one failure that skipped the
// teardown would manufacture failures in the tests after it and bury its own
// message - the lesson test/dispatch.test.js records at its project-busy test.
async function drain() {
  scheduler.stop();
  await waitFor('dispatch to drain', () => {
    // cancelAll() ON EVERY POLL, not once. It skips an order whose handle is
    // still null - one inside `git worktree add` - which lib/dispatch records
    // as a residual of its own: that order then passes its intent check, spawns
    // its agent AFTER the cancel, and sleeps out the shim's full timeout. A
    // single call left a 60s agent alive and timed the teardown out, which
    // surfaced as a failure in the test that had already passed its assertions.
    dispatch.cancelAll();
    return dispatch.inFlightCount() === 0;
  }, 30000);
  dispatch.setCapacity(null);
}

const OK = '#!/bin/sh\necho "did the work"\nexit 0\n';
function tallyShim(tally, seconds) {
  return shimAgent(`#!/bin/sh\necho "$$" >> "${tally}"\nsleep ${seconds}\nexit 0\n`);
}

// A goal with its orders already created, attached and persisted - the shape
// lib/plan leaves behind, built without running a PM.
function plannedGoal(root, project, prompts) {
  const goal = goals.create(root, { projectId: project.id, text: 'do the thing' });
  const made = prompts.map((p, seq) => {
    const o = orders.create(root, { projectId: project.id, prompt: p });
    orders.attachToGoal(root, o.id, goal.id, seq);
    return o;
  });
  goals.planned(root, goal.id, { orderIds: made.map((o) => o.id), pmAgent: 'fake' });
  return { goal, made };
}

test('a goal\'s queued orders run without anyone dispatching them', async () => {
  // The whole point of the module: nothing here calls dispatch, and no HTTP
  // route is involved. Mutant: tick() does nothing - both orders stay queued
  // and this times out.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const { goal, made } = plannedGoal(root, project, ['one', 'two']);
  const agent = shimAgent(OK);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await waitFor('both orders to settle', () => {
      const a = orders.get(root, made[0].id);
      const b = orders.get(root, made[1].id);
      return orders.SETTLED.has(a.status) && orders.SETTLED.has(b.status) && { a, b };
    });
    const { a, b } = await waitFor('the goal to be marked done',
      () => goals.get(root, goal.id).status === 'done'
        && { a: orders.get(root, made[0].id), b: orders.get(root, made[1].id) });

    assert.strictEqual(a.status, 'succeeded', `first order: ${a.status} ${a.error}`);
    assert.strictEqual(b.status, 'succeeded', `second order: ${b.status} ${b.error}`);
    assert.strictEqual(a.agent, 'fake');
    assert.strictEqual(scheduler.stats().dispatched, 2);
    // The advisory checks were not merely harmless, they were RIGHT: nothing
    // was picked that runOrder then refused.
    assert.strictEqual(scheduler.stats().refused, 0);
  } finally {
    await drain();
  }
});

test('the scheduler never exceeds the global ceiling', async () => {
  // SIX DISTINCT GIT PROJECTS, and the distinctness is the point. With one dir
  // project, projectBusy answers before atCapacity is ever consulted, so the
  // ceiling check would never be reached and the test would pass with it
  // deleted - an input that cannot reach the path it names. Six separate repos
  // leave atCapacity as the only thing standing between one agent and six.
  //
  // TWO ASSERTIONS, because they pin different owners. The ps-verified peak is
  // runOrder's property: it enforces the ceiling itself, so deleting the check
  // in the scheduler still yields ONE agent - dispatch refuses the other five.
  // What the scheduler's check owns is that those five refusals never happen,
  // so stats().refused is what kills the mutant and the peak is corroboration.
  const root = tmpDir('skillspace-home-');
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');
  const agent = tallyShim(tally, 30);
  const made = [];
  for (let i = 0; i < 6; i++) {
    const project = projects.create(root, { path: tmpGitRepo() });
    assert.strictEqual(project.kind, 'git');
    made.push(orders.create(root, { projectId: project.id, prompt: `order ${i}` }));
  }
  assert.strictEqual(new Set(made.map((o) => o.projectId)).size, 6,
    'the six orders must be on six different projects for atCapacity to be reachable');

  dispatch.setCapacity(() => dispatch.inFlightCount() >= 1);
  let peak = 0;
  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await waitFor('the first agent to record itself', () => pidsIn(tally).length >= 1);
    // Sample repeatedly rather than once: a single reading after a fixed sleep
    // can miss a burst that has already exited.
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      peak = Math.max(peak, aliveCount(pidsIn(tally)));
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(peak >= 1, 'no agent ran at all - this test proved nothing');
    assert.strictEqual(peak, 1, `${peak} agents were alive at once under a ceiling of 1`);
    assert.strictEqual(scheduler.stats().refused, 0,
      'the scheduler dispatched past the ceiling and runOrder had to refuse it');
    assert.strictEqual(scheduler.stats().dispatched, 1);
    // Guards a vacuous pass: five orders must still be waiting, not settled.
    const queued = made.filter((o) => orders.get(root, o.id).status === 'queued').length;
    assert.strictEqual(queued, 5, 'the other five orders were not left queued');
  } finally {
    await drain();
  }
});

test('a dir project gets one order at a time', async () => {
  // Mutant: the projectBusy check removed.
  //
  // The agent count CANNOT be the assertion that kills it. runOrder refuses a
  // second concurrent order on an unisolated project itself - that is the guard
  // an agent count measures - so with the scheduler's check gone there is still
  // exactly ONE agent, and the order simply stays queued and is retried. The
  // observable that changes is the refusal: with the check, none; without it,
  // one per extra candidate per tick, forever.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  assert.strictEqual(project.kind, 'dir');
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');
  const agent = tallyShim(tally, 30);
  const made = ['a', 'b', 'c'].map((p) => orders.create(root, { projectId: project.id, prompt: p }));

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await waitFor('the first agent to record itself', () => pidsIn(tally).length >= 1);
    await ticksPass(6, 15);

    assert.strictEqual(scheduler.stats().refused, 0,
      'the scheduler kept offering orders runOrder had to refuse as project busy');
    assert.strictEqual(scheduler.stats().dispatched, 1);
    assert.strictEqual(aliveCount(pidsIn(tally)), 1,
      'more than one agent was alive in the user\'s own directory');
    // OLDEST FIRST, and this is the only place it is observable: a project that
    // runs one order at a time makes the selection order the execution order.
    // orders.list() is newest-first by contract, so a scheduler that forgot to
    // reverse would run the LAST order created and starve the first forever.
    assert.notStrictEqual(orders.get(root, made[0].id).status, 'queued',
      'the oldest queued order was not the one picked');
    assert.strictEqual(orders.get(root, made[1].id).status, 'queued');
    assert.strictEqual(orders.get(root, made[2].id).status, 'queued');
  } finally {
    await drain();
  }
});

test('a project claimed by a planning PM is not dispatched into', async () => {
  // THE "settled order does not mean the project is claimable" PROPERTY, pinned
  // deterministically instead of through the settlement window.
  //
  // The window itself - the microseconds between an order's record settling and
  // projectOf.delete running after worktrees.cleanup - cannot be landed on
  // reliably from a poll loop, so a test aimed at it would be flaky in the
  // direction that reads green. The property underneath is what matters and it
  // is exactly testable: projectOf holds claims that the ORDER RECORDS DO NOT
  // SHOW, so a scheduler keying off record status dispatches into a held
  // project. lib/plan makes the same claim under a GOAL id while a PM
  // decomposes, which is the same registry, the same invisibility, and holds
  // for as long as the test likes.
  //
  // Kills two mutants: polling `order.status` instead of dispatch.projectBusy(),
  // and asking dispatch.isClaimed(order.id) instead - isClaimed reads inFlight,
  // which only runOrder writes, so it is FALSE for this claim.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const order = orders.create(root, { projectId: project.id, prompt: 'wait your turn' });
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');
  const agent = tallyShim(tally, 2);
  const pmKey = 'goal-00000000000000-0000-not-a-real-goal';

  dispatch.claimProject(pmKey, project.id);
  let released = false;
  try {
    assert.strictEqual(dispatch.isClaimed(order.id), false,
      'isClaimed must not see a project claim - that is the whole hazard');
    assert.strictEqual(dispatch.projectBusy(project.id), true);

    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await ticksPass(6, 15);

    assert.strictEqual(orders.get(root, order.id).status, 'queued');
    assert.strictEqual(scheduler.stats().dispatched, 0,
      'the scheduler dispatched into a project a PM was holding');
    assert.strictEqual(scheduler.stats().refused, 0);
    assert.strictEqual(pidsIn(tally).length, 0, 'an agent ran in a directory a PM was in');

    // And it is not simply stuck: releasing the claim lets it through, so the
    // assertions above are about the claim rather than about nothing working.
    dispatch.releaseProject(pmKey);
    released = true;
    await waitFor('the order to run once the PM releases the project',
      () => orders.get(root, order.id).status !== 'queued');
    assert.strictEqual(scheduler.stats().refused, 0);
  } finally {
    if (!released) dispatch.releaseProject(pmKey);
    await drain();
  }
});

test('an order already claimed is not dispatched again', async () => {
  // Mutant: the isClaimed check removed.
  //
  // The window this guards is real but narrow: runOrder claims synchronously
  // and only marks the record `running` after `git worktree add`, so between
  // those two moments the order reads `queued` on disk while being dispatched.
  // A post-checkout hook that sleeps holds `worktree add` open for a full
  // second - measured, and lib/worktrees names a stalled post-checkout hook as
  // a real hazard - so the window is wide enough that a 15ms loop must tick
  // inside it many times rather than by luck.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
  const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
  fs.writeFileSync(hook, '#!/bin/sh\nsleep 1\nexit 0\n');
  fs.chmodSync(hook, 0o755);
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'slow to prepare' });
  const agent = shimAgent(OK);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    // Claimed almost immediately - start() ticks synchronously - and still
    // reading `queued` because the hook is holding the checkout open.
    await waitFor('the order to be claimed', () => dispatch.isClaimed(order.id));
    assert.strictEqual(orders.get(root, order.id).status, 'queued',
      'the prepare window closed too fast for this test to mean anything');
    const ticksInWindow = scheduler.stats().ticks;
    await waitFor('several ticks inside the prepare window',
      () => scheduler.stats().ticks >= ticksInWindow + 5 || !dispatch.isClaimed(order.id));
    assert.ok(dispatch.isClaimed(order.id),
      'the window closed before the loop could tick inside it');

    assert.strictEqual(scheduler.stats().dispatched, 1,
      'the same order was dispatched more than once while it was still queued');
    assert.strictEqual(scheduler.stats().refused, 0,
      'runOrder had to refuse a duplicate the scheduler should not have offered');

    await waitFor('the order to settle', () => orders.SETTLED.has(orders.get(root, order.id).status));
    assert.strictEqual(orders.get(root, order.id).status, 'succeeded');
    assert.strictEqual(scheduler.stats().refused, 0);
  } finally {
    await drain();
  }
});

test('the scheduler stops cleanly and starts nothing after stop()', async () => {
  // Mutant: stop() clears the timer but not the loop state. Both halves are
  // asserted, because the two failures look nothing alike: leaving the timer
  // set keeps dispatching, and leaving `ticking` set makes every future tick
  // return immediately - a scheduler that reports itself started and does
  // nothing at all, which only a RESTART can detect.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const first = orders.create(root, { projectId: project.id, prompt: 'before stop' });
  const agent = shimAgent(OK);
  const opts = { intervalMs: 15, childEnv: testEnv, agentFor: () => agent };

  try {
    scheduler.start(root, opts);
    await waitFor('the first order to settle',
      () => orders.SETTLED.has(orders.get(root, first.id).status));
    await waitFor('dispatch to drain', () => dispatch.inFlightCount() === 0);
    scheduler.stop();

    const ticksAtStop = scheduler.stats().ticks;
    const second = orders.create(root, { projectId: project.id, prompt: 'after stop' });
    await new Promise((r) => setTimeout(r, 300)); // 20 intervals' worth
    assert.strictEqual(scheduler.stats().ticks, ticksAtStop, 'the loop kept ticking after stop()');
    assert.strictEqual(orders.get(root, second.id).status, 'queued',
      'an order created after stop() was dispatched anyway');
    assert.strictEqual(scheduler.stats().running, false);

    // The restart. This is what catches a stop() that left the re-entrancy flag
    // set, or left the timer handle in place so start() refuses.
    scheduler.start(root, opts);
    await waitFor('the second order to settle',
      () => orders.SETTLED.has(orders.get(root, second.id).status));
    assert.strictEqual(orders.get(root, second.id).status, 'succeeded');
  } finally {
    await drain();
  }
  // Safe to call when not started, exactly as worktrees.cleanup is safe twice.
  scheduler.stop();
  scheduler.stop();
});

test('a tick that throws does not kill the loop', async () => {
  // A poll loop that dies silently is indistinguishable from one that has no
  // work: the board fills with queued orders and nothing says why.
  //
  // Mutant: the try/catch around tick() removed. start() runs its first tick
  // synchronously, so the throw escapes start() itself and this fails on the
  // line below rather than at an assertion.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const order = orders.create(root, { projectId: project.id, prompt: 'after the failure' });
  const agent = shimAgent(OK);

  const realList = orders.list;
  let thrown = 0;
  // Patched on the module object, which is the same object lib/scheduler
  // required - it calls orders.list(...) rather than holding a destructured
  // reference, so this reaches it.
  orders.list = function (...args) {
    if (thrown === 0) { thrown = 1; throw new Error('the store blinked'); }
    return realList.apply(this, args);
  };

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    assert.strictEqual(scheduler.stats().errors, 1, 'the first tick\'s throw was not recorded');
    assert.match(scheduler.stats().lastError, /the store blinked/);
    await waitFor('the order to settle after the failed tick',
      () => orders.SETTLED.has(orders.get(root, order.id).status));
    assert.strictEqual(orders.get(root, order.id).status, 'succeeded');
    assert.ok(scheduler.stats().ticks > 1, 'the loop did not tick again');
  } finally {
    orders.list = realList;
    await drain();
  }
});

test('per-goal spend is bounded', async () => {
  // Mutant: the withinBudget check removed - all three orders run.
  const root = tmpDir('skillspace-home-');
  // concurrency 3 on a git project, so all three orders could run at once and
  // the per-goal cap is the ONLY thing that can stop the second and third.
  // Without that the project bound does the work and the budget check is never
  // reached - the shape that hid a stale `spent` until a reviewer narrowed
  // projectBusy and got "3 orders ran under a per-goal cap of 1".
  const project = projects.create(root, {
    path: tmpGitRepo(),
    concurrency: 3,
    budget: { maxOrdersPerGoal: 1 },
  });
  assert.strictEqual(project.budget.maxOrdersPerGoal, 1,
    'projects.safeBudget did not keep the cap this test depends on');
  assert.strictEqual(project.concurrency, 3,
    'projects.safeConcurrency did not keep the concurrency this test depends on');
  const { goal, made } = plannedGoal(root, project, ['one', 'two', 'three']);
  const agent = shimAgent(OK);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await waitFor('the first order to settle',
      () => orders.SETTLED.has(orders.get(root, made[0].id).status));
    await waitFor('dispatch to drain', () => dispatch.inFlightCount() === 0);
    await ticksPass(6, 15);

    const settled = made.filter((o) => orders.SETTLED.has(orders.get(root, o.id).status));
    assert.strictEqual(settled.length, 1, `${settled.length} orders ran under a per-goal cap of 1`);
    assert.strictEqual(scheduler.stats().dispatched, 1);
    assert.strictEqual(orders.get(root, made[1].id).status, 'queued');
    assert.strictEqual(orders.get(root, made[2].id).status, 'queued');
    // The documented cost of bounding it here: the goal never reaches `done`,
    // because two of the orders it names never settle. Asserted so the Known
    // limit is a measured statement rather than a guess.
    assert.strictEqual(goals.get(root, goal.id).status, 'planned');
  } finally {
    await drain();
  }
});

test('a goal whose orders all settled during boot is finished by the first tick', async () => {
  // THE STARTUP SWEEP, and lib/goals names this module as its audience: boot
  // settles a crashed goal's orders and then demotes the goal to `planned`, so
  // a goal can come out of boot claiming outstanding work with none. No further
  // settlement event will ever fire for it, so a purely reactive scheduler
  // leaves it claiming work forever - reproduction is a single restart.
  //
  // Asserted SYNCHRONOUSLY after start() returns, with no polling. That is not
  // a convenience: it pins that the sweep happens at startup rather than after
  // the first interval, and kills the mutant that only schedules the timer.
  // The other mutant it kills is the whole goal-reconciliation pass.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const { goal, made } = plannedGoal(root, project, ['one', 'two']);
  // What boot leaves behind: every order settled, the goal still `planned`.
  orders.markFinished(root, made[0].id, { exitCode: 0 });
  orders.markFinished(root, made[1].id, { error: 'interrupted' });
  assert.strictEqual(goals.get(root, goal.id).status, 'planned');

  try {
    scheduler.start(root, {
      intervalMs: 60000, // long enough that only the startup tick can pass this
      childEnv: testEnv,
      agentFor: () => shimAgent(OK),
    });
    const after = goals.get(root, goal.id);
    assert.strictEqual(after.status, 'done',
      'the goal still claimed outstanding work after the scheduler started');
    assert.ok(after.finishedAt, 'markDone did not stamp finishedAt');
    assert.strictEqual(scheduler.stats().ticks, 1);
    assert.strictEqual(scheduler.stats().dispatched, 0);
  } finally {
    await drain();
  }
});

test('an order attached to a goal still being planned is not dispatched', async () => {
  // Mutant: only goals.SETTLED is checked, and `planning` falls through.
  //
  // NOT a throughput concern. lib/plan creates and attaches each order as it
  // goes and only calls goals.planned at the end, so there is a real window in
  // which a queued order carries the goalId of an unfinished plan. If
  // persisting that plan then fails, plan.js's rollback calls
  // orders.markCancelled on every id it recorded - settling an order this loop
  // may have put an agent on, behind dispatch's back, which is precisely the
  // "nothing may settle a record another dispatch already owns" invariant
  // runOrder is built around. plan.js calls it "invisible work a scheduler may
  // still run".
  //
  // A git project on purpose: nothing holds the project, so with the check gone
  // the order really is dispatched and really does spawn - the mutant's damage
  // is an agent, not a refusal.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const goal = goals.create(root, { projectId: project.id, text: 'half a plan' });
  assert.strictEqual(goal.status, 'planning');
  const order = orders.create(root, { projectId: project.id, prompt: 'first of three' });
  orders.attachToGoal(root, order.id, goal.id, 0);
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');
  const agent = tallyShim(tally, 2);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await ticksPass(6, 15);
    assert.strictEqual(scheduler.stats().dispatched, 0,
      'an order was dispatched while its goal was still being decomposed');
    assert.strictEqual(pidsIn(tally).length, 0, 'an agent ran for a plan that does not exist yet');
    assert.strictEqual(orders.get(root, order.id).status, 'queued');

    // And it runs the moment the plan is persisted, so the assertions above are
    // about `planning` rather than about the order being unrunnable.
    goals.planned(root, goal.id, { orderIds: [order.id], pmAgent: 'fake' });
    await waitFor('the order to run once the plan exists',
      () => orders.get(root, order.id).status !== 'queued');
  } finally {
    await drain();
  }
});

test('a goal is never marked done over work that is not there', async () => {
  // Two mutants, one property - `done` is SETTLED and never rewritten, so a
  // wrong `done` is the record's last word.
  //
  // Mutant A: the orderIds.length check removed. "Every order it names has
  // settled" is VACUOUSLY TRUE of a goal that names none, which is the exact
  // reason goals.planned refuses an empty plan.
  // Mutant B: a missing order counted as settled. A goal then finishes over an
  // order that was deleted or quarantined.
  //
  // Both records are written straight through store.js: goals.planned refuses
  // an empty orderIds by design, so the only way to hold a corrupt one is to
  // put it there - which is also the only way it arises in life, a hand-edited
  // or half-written file.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });

  const empty = goals.create(root, { projectId: project.id, text: 'names nothing' });
  store.writeJson(root, `goals/${empty.id}.json`,
    { ...goals.get(root, empty.id), status: 'planned', orderIds: [] });

  const ghosted = goals.create(root, { projectId: project.id, text: 'names a ghost' });
  const real = orders.create(root, { projectId: project.id, prompt: 'the one that exists' });
  orders.attachToGoal(root, real.id, ghosted.id, 0);
  orders.markFinished(root, real.id, { exitCode: 0 });
  goals.planned(root, ghosted.id, {
    orderIds: [real.id, 'ord-00000000000000-0000-deleted-since'],
    pmAgent: 'fake',
  });

  try {
    scheduler.start(root, {
      intervalMs: 60000,
      childEnv: testEnv,
      agentFor: () => shimAgent(OK),
    });
    assert.strictEqual(goals.get(root, empty.id).status, 'planned',
      'a goal that names no orders was settled as done');
    assert.strictEqual(goals.get(root, ghosted.id).status, 'planned',
      'a goal was settled as done over an order that does not exist');
  } finally {
    await drain();
  }
});

test('a goal goes back to planned when nothing of it is in flight', async () => {
  // Mutant: the markPlanned branch removed, leaving the goal at `running`.
  //
  // A goal reading `running` while every agent has exited is the same lie the
  // state machine was rebuilt to remove - work in flight with nothing alive -
  // moved one state to the right. It is reachable whenever an order settles and
  // the next is blocked, which the capacity predicate here makes deterministic
  // instead of waiting for a real ceiling.
  // A DIR project, deliberately: it is serialised to one order at a time, so
  // settling the running one leaves the goal with genuinely nothing in flight.
  // On a git project this fixture no longer reaches the demotion at all - both
  // orders start together under project.concurrency, so cancelling one leaves
  // the other running and the goal correctly stays `running`. That is the shape
  // that stopped being reachable when the concurrency bound landed.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  assert.strictEqual(project.kind, 'dir');
  const { goal, made } = plannedGoal(root, project, ['first', 'second']);
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');
  const agent = tallyShim(tally, 60);
  let blocked = false;
  dispatch.setCapacity(() => blocked);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await waitFor('the goal to read running', () => goals.get(root, goal.id).status === 'running');
    // Wait for the AGENT to have recorded itself, not merely for the order to
    // be claimed. dispatch claims before `git worktree add` and installs the
    // cancel handle only after it, and dispatch.cancel() returns false and does
    // nothing for an entry whose handle is still null. Cancelling in that
    // window left the agent running and timed this test out at twenty seconds
    // on a property it had never reached. runner.start returns the handle
    // before the child can write anything, so a pid in the tally means the
    // handle is installed.
    await waitFor('the first agent to record itself', () => pidsIn(tally).length >= 1);
    const firstId = made.map((o) => o.id).find((id) => dispatch.isClaimed(id));
    assert.ok(firstId, 'no order was in flight once an agent had started');

    // Close the ceiling BEFORE settling the running order, so the next one
    // cannot start and the goal genuinely has nothing in flight.
    blocked = true;
    assert.strictEqual(dispatch.cancel(firstId), true, 'the cancel never reached the agent');
    await waitFor('the goal to be demoted back to planned',
      () => goals.get(root, goal.id).status === 'planned');

    const other = made.map((o) => o.id).find((id) => id !== firstId);
    assert.strictEqual(orders.get(root, other).status, 'queued');
    assert.strictEqual(orders.get(root, firstId).status, 'cancelled');

    // Not terminal: the demotion must not strand the goal.
    blocked = false;
    await waitFor('the goal to read running again once the ceiling lifts',
      () => goals.get(root, goal.id).status === 'running');
  } finally {
    await drain();
  }
});

test('the scheduler does not burn a backlog against a reached daily cap', async () => {
  // runOrder DOES enforce maxOrdersPerDay - by marking the order FAILED, which
  // is settled and never retried. A human dispatching by hand burns one order
  // that way. A loop dispatching everything queued burns the entire backlog in
  // a single tick, permanently, the moment the cap is reached.
  //
  // Mutant: the countToday check removed - every order comes back `failed` with
  // "daily limit reached" and the work is gone.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, {
    path: tmpGitRepo(),
    budget: { maxOrdersPerDay: 1 },
  });
  assert.strictEqual(project.budget.maxOrdersPerDay, 1);
  const made = ['a', 'b', 'c'].map((p) => orders.create(root, { projectId: project.id, prompt: p }));
  // Three orders exist today against a cap of 1, so runOrder's own
  // `countToday > cap` is already true of every one of them.
  assert.ok(orders.countToday(root, project.id) > 1);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    await ticksPass(6, 15);
    for (const o of made) {
      const rec = orders.get(root, o.id);
      assert.strictEqual(rec.status, 'queued',
        `order ${o.id} was ${rec.status} (${rec.error}) instead of left for tomorrow`);
    }
    assert.strictEqual(scheduler.stats().dispatched, 0);
  } finally {
    await drain();
  }
});

test('an order with no agent available is left queued, not failed', async () => {
  // Mutant: the absent agent passed through to runOrder, which answers with
  // markFailed('no agent available') - SETTLED, never retried. One missing
  // binary would settle every queued order in the store on the first tick.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const order = orders.create(root, { projectId: project.id, prompt: 'nobody to run me' });

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => null });
    await ticksPass(4, 15);
    assert.strictEqual(orders.get(root, order.id).status, 'queued',
      'a missing agent settled the order instead of leaving it for later');
    assert.strictEqual(scheduler.stats().dispatched, 0);
  } finally {
    await drain();
  }
});

test('childEnv and agentFor are required, and a second start is refused', async () => {
  // Mutant: childEnv defaulted to process.env - the leak the allowlist exists
  // to prevent, and the third time this codebase has had to refuse it.
  const root = tmpDir('skillspace-home-');
  assert.throws(() => scheduler.start(root, { agentFor: () => null }), /childEnv is required/);
  assert.throws(() => scheduler.start(root, { childEnv: testEnv }), /agentFor is required/);
  assert.throws(() => scheduler.start('', { childEnv: testEnv, agentFor: () => null }),
    /root is required/);
  assert.strictEqual(scheduler.stats().running, false,
    'a refused start left the loop running');

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => null });
    // Refused rather than silently replaced: a replace leaks the first timer and
    // leaves a loop dispatching against a root nobody remembers configuring.
    assert.throws(
      () => scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => null }),
      /already started/
    );
  } finally {
    await drain();
  }
});

test('the timer does not hold the process open', async () => {
  // Mutant: the .unref() removed - the child below never exits and this times
  // out. Verified in a child process because an unref'd timer has no observable
  // effect inside a test runner that is staying alive for other reasons.
  const root = tmpDir('skillspace-home-');
  const lib = path.join(__dirname, '..', 'lib', 'scheduler.js');
  const started = Date.now();
  const out = execFileSync(process.execPath, [
    '-e',
    `const s = require(${JSON.stringify(lib)});`
    + `s.start(${JSON.stringify(root)}, { intervalMs: 20, childEnv: () => ({}), agentFor: () => null });`
    + `console.log('started');`,
  ], { encoding: 'utf8', timeout: 15000 });
  assert.match(out, /started/);
  assert.ok(Date.now() - started < 15000, 'the process was held open by the scheduler timer');
});

test('a goal the PM could not plan does not have its orders run', async () => {
  // Mutant: the goals.SETTLED check removed.
  //
  // The reachable shape is lib/plan's rollback, and plan.js spells it out: when
  // persisting a plan fails it cancels every order it created, but "a rollback
  // that itself fails is not swallowed" - those orders stay `queued` with a
  // goalId pointing at a goal about to be marked failed. That is the invisible
  // work plan.js says a scheduler may still run, and this is the check that
  // stops it. `failed` is SETTLED, so nothing will ever revive the plan.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const goal = goals.create(root, { projectId: project.id, text: 'never planned' });
  const order = orders.create(root, { projectId: project.id, prompt: 'orphaned by a rollback' });
  orders.attachToGoal(root, order.id, goal.id, 0);
  goals.failPlanning(root, goal.id, 'could not persist the plan');
  assert.strictEqual(goals.get(root, goal.id).status, 'failed');

  try {
    // A long interval so only the startup tick can run: the assertion is
    // synchronous and cannot be a race.
    scheduler.start(root, { intervalMs: 60000, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    assert.strictEqual(scheduler.stats().dispatched, 0,
      'an order belonging to a failed goal was dispatched');
    assert.strictEqual(orders.get(root, order.id).status, 'queued');
    assert.strictEqual(scheduler.stats().errors, 0,
      `the tick threw rather than skipping: ${scheduler.stats().lastError}`);
  } finally {
    await drain();
  }
});

test('an order naming a goal that cannot be read is left queued', async () => {
  // Mutant: the missing-goal guard removed, so an unreadable goal reads as
  // "nothing to object to" and the order runs.
  //
  // Fail closed: with no goal record there is no way to tell whether the plan
  // is settled, or still being decomposed by a PM whose rollback would cancel
  // this order underneath a running agent. store.js quarantines a goal file it
  // cannot parse, so this is reachable without anyone deleting anything.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const order = orders.create(root, { projectId: project.id, prompt: 'my goal is gone' });
  // attachToGoal validates the SHAPE of the id, not that it names anything.
  orders.attachToGoal(root, order.id, 'goal-00000000000000-0000-quarantined', 0);
  assert.strictEqual(goals.get(root, 'goal-00000000000000-0000-quarantined'), null);

  try {
    scheduler.start(root, { intervalMs: 60000, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    assert.strictEqual(scheduler.stats().dispatched, 0,
      'an order was run for a goal whose record could not be read');
    assert.strictEqual(orders.get(root, order.id).status, 'queued');
    // NOT BY CRASHING. Without the guard the null record falls through to
    // `goal.status` and the tick dies of a TypeError - which also leaves the
    // order queued and dispatches nothing, so the two assertions above pass
    // just as happily on a scheduler that throws on every single tick. The
    // mutation sweep found exactly that, and this is the line that tells the
    // handled case from the crashing one.
    assert.strictEqual(scheduler.stats().errors, 0,
      `the tick threw instead of skipping the order: ${scheduler.stats().lastError}`);
  } finally {
    await drain();
  }
});

test('a tick that changes nothing does not rewrite the goal record', async () => {
  // Mutant: the `desired === goal.status` short-circuit removed.
  //
  // lib/goals states this as a limit aimed at exactly this caller: moveLive
  // REWRITES on a no-op transition - mkdir, write, rename - so calling
  // markRunning once per tick on a goal that is already running rewrites every
  // goal's file every tick with byte-identical data. goals.js also explains why
  // it cannot short-circuit generically (markDone stamps finishedAt), which is
  // why the caller owns it and why it is worth pinning here.
  //
  // mtimeMs is the observable. store.js writes to a temp file and renames, so a
  // rewrite always moves mtime even when the bytes are identical.
  // A DIR project so the goal parks in a genuinely stable state: one order
  // running, one queued behind it, nothing changing tick to tick. A git project
  // would start both and the second's settlement would move the goal for real,
  // which measures nothing about no-op writes.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const { goal, made } = plannedGoal(root, project, ['long one', 'the other']);
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');
  const agent = tallyShim(tally, 60);
  const file = path.join(root, 'goals', `${goal.id}.json`);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await waitFor('the goal to read running', () => goals.get(root, goal.id).status === 'running');
    await waitFor('the first agent to record itself', () => pidsIn(tally).length >= 1);

    const before = fs.statSync(file).mtimeMs;
    await ticksPass(8, 15);
    assert.strictEqual(goals.get(root, goal.id).status, 'running',
      'the goal changed state, so this measures nothing');
    assert.strictEqual(fs.statSync(file).mtimeMs, before,
      'the goal record was rewritten by ticks that changed nothing about it');
    assert.strictEqual(orders.get(root, made[1].id).status, 'queued');
  } finally {
    await drain();
  }
});

test('stop() does not leak the interval it was holding', async () => {
  // Mutant: stop() drops its reference to the timer without clearInterval.
  //
  // Invisible while stopped - the orphaned interval fires into a tick that
  // returns immediately because there is no config - and then very visible on
  // RESTART, when the orphan starts finding a config again and the loop polls
  // at twice the rate it was configured for. Every stop/start cycle adds
  // another one.
  //
  // The assertion is an UPPER bound on ticks per unit time, which is the
  // direction that is safe under load: a busy machine ticks fewer times than
  // its interval allows, never more. A lower bound here would be the flake.
  const root = tmpDir('skillspace-home-');
  const opts = { intervalMs: 50, childEnv: testEnv, agentFor: () => null };
  const WINDOW_MS = 600;
  const ALLOWED = Math.ceil(WINDOW_MS / opts.intervalMs) + 3; // 15, against 24 for two timers

  try {
    scheduler.start(root, opts);
    scheduler.stop();
    scheduler.start(root, opts);
    const before = scheduler.stats().ticks;
    await new Promise((r) => setTimeout(r, WINDOW_MS));
    const elapsed = scheduler.stats().ticks - before;
    assert.ok(elapsed <= ALLOWED,
      `${elapsed} ticks in ${WINDOW_MS}ms at a ${opts.intervalMs}ms interval `
      + `(at most ${ALLOWED} expected): a stopped interval is still firing`);
    assert.ok(elapsed >= 1, 'the loop did not tick at all - this test measured nothing');
  } finally {
    await drain();
  }
});

test('an interval below the floor is not honoured literally', async () => {
  // Mutant: the MIN_INTERVAL_MS floor dropped, so a caller asking for 1ms gets
  // 1ms - a poll loop that re-reads every order record on the store a thousand
  // times a second and starves everything else on the event loop.
  //
  // An interval under the floor is treated as unconfigured and falls back to
  // the default rather than being clamped up to the floor: a caller passing 1
  // has not made a considered choice about cadence, and the default is the
  // considered one.
  //
  // Again an UPPER bound, the direction that is safe under load.
  const root = tmpDir('skillspace-home-');
  const WINDOW_MS = 400;

  try {
    scheduler.start(root, { intervalMs: 1, childEnv: testEnv, agentFor: () => null });
    const before = scheduler.stats().ticks;
    await new Promise((r) => setTimeout(r, WINDOW_MS));
    const elapsed = scheduler.stats().ticks - before;
    // A 1ms interval would give hundreds; the 1000ms default gives none or one.
    assert.ok(elapsed <= 20,
      `${elapsed} ticks in ${WINDOW_MS}ms: a sub-floor interval was taken literally`);
  } finally {
    await drain();
  }
});

test('a git project runs up to its configured concurrency, and no more', async () => {
  // The knob lib/dispatch's header says this loop is for, and that the plan
  // promised in three places while prescribing a Step 3 that could not keep it.
  //
  // EQUALITY, not an upper bound, and that is the point: `>= 999` (no bound)
  // gives four agents and fails, and reverting to the projectBusy question -
  // which is what this file shipped first - gives ONE and fails too. A `<= 2`
  // assertion would have passed the serialised version and pinned nothing.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo(), concurrency: 2 });
  assert.strictEqual(project.kind, 'git');
  assert.strictEqual(project.concurrency, 2);
  const made = ['a', 'b', 'c', 'd'].map((p) =>
    orders.create(root, { projectId: project.id, prompt: p }));
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');
  const agent = tallyShim(tally, 30);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    // Both slots filled, then hold still long enough for a third to appear if
    // the bound were not there. `git worktree add` is serialised per repo, so
    // the second agent trails the first by a prepare rather than starting with
    // it - waiting on the pid count is what makes this deterministic.
    await waitFor('two agents to record themselves', () => pidsIn(tally).length >= 2);
    await ticksPass(8, 15);

    const alive = aliveCount(pidsIn(tally));
    assert.strictEqual(alive, 2,
      `${alive} agents alive on a project configured for 2`);
    assert.strictEqual(scheduler.stats().dispatched, 2);
    assert.strictEqual(scheduler.stats().refused, 0);
    const queued = made.filter((o) => orders.get(root, o.id).status === 'queued').length;
    assert.strictEqual(queued, 2, 'the other two orders were not left queued');
  } finally {
    await drain();
  }
});

test('an order naming a project that cannot be read is left queued', async () => {
  // Mutant: the missing-project guard removed. Reachable without anyone
  // deleting anything - projects.get() returns null for an id it does not know,
  // and projects.json is a single file the store can quarantine whole.
  //
  // The errors assertion is the half that matters, and the sibling missing-goal
  // test learned it the hard way: without the guard, `project.id` throws a
  // TypeError, which ALSO leaves the order queued and dispatches nothing. The
  // two obvious assertions pass just as happily on a loop that crashes on every
  // tick forever, so this is what tells a handled skip from a dead scheduler.
  const root = tmpDir('skillspace-home-');
  const order = orders.create(root, { projectId: 'proj-never-existed', prompt: 'homeless' });
  assert.strictEqual(projects.get(root, 'proj-never-existed'), null);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    await ticksPass(4, 15);
    assert.strictEqual(orders.get(root, order.id).status, 'queued');
    assert.strictEqual(scheduler.stats().dispatched, 0);
    assert.strictEqual(scheduler.stats().errors, 0,
      `the tick threw instead of skipping the order: ${scheduler.stats().lastError}`);
  } finally {
    await drain();
  }
});

test('a hand-edited concurrency of 0 means one, not unlimited and not none', async () => {
  // The failure shape the standing questions name outright: `maxOrdersPerGoal:
  // 0` once read as unlimited. A concurrency of 0 has BOTH ways to be wrong,
  // and this pins the middle - the mutant that reads 0 as no limit runs two
  // agents, and the mutant that compares against 0 literally runs none and
  // wedges the project forever.
  //
  // projects.create clamps this on the way in, so the record is written
  // directly: projects.get returns a stored record verbatim when the detected
  // kind matches, which is what makes a hand-edited projects.json reachable.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo(), concurrency: 2 });
  const listed = store.readJson(root, 'projects.json', []);
  store.writeJson(root, 'projects.json',
    listed.map((p) => (p.id === project.id ? { ...p, concurrency: 0 } : p)));
  const reread = projects.get(root, project.id);
  assert.strictEqual(reread.concurrency, 0, 'the corrupt value did not survive the read');
  assert.strictEqual(reread.kind, 'git');

  const made = ['a', 'b'].map((p) => orders.create(root, { projectId: project.id, prompt: p }));
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');
  const agent = tallyShim(tally, 30);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await waitFor('an agent to record itself', () => pidsIn(tally).length >= 1);
    await ticksPass(8, 15);
    assert.strictEqual(aliveCount(pidsIn(tally)), 1,
      'a concurrency of 0 was read as no limit at all');
    assert.strictEqual(scheduler.stats().dispatched, 1);
    assert.strictEqual(made.filter((o) => orders.get(root, o.id).status === 'queued').length, 1);
  } finally {
    await drain();
  }
});

test('a goal whose plan names a vanished order does not overspend its budget', async () => {
  // Mutant: `spent` ignores an id with no record in the snapshot, and the cap
  // admits one more order than it should.
  //
  // FAIL CLOSED, deliberately. A missing id may be an order that ran and whose
  // file store.js has since quarantined, so counting it as unspent is a cap
  // that stops being a cap exactly when the store is damaged. The cost is the
  // other direction - a goal that stalls short of its cap - which is visible in
  // the record and is the same direction reconcileGoals takes on a missing
  // order when it refuses to call such a goal `done`.
  const root = tmpDir('skillspace-home-');
  // Cap 1 against a plan of two, one of which has vanished. The arithmetic is
  // the test: counting the vanished one makes spent 1, so the survivor would be
  // the second spend and is refused; ignoring it makes spent 0 and the survivor
  // runs. A cap of 2 leaves room either way and would have pinned nothing -
  // this fixture failed that way first.
  const project = projects.create(root, {
    path: tmpGitRepo(),
    concurrency: 3,
    budget: { maxOrdersPerGoal: 1 },
  });
  const goal = goals.create(root, { projectId: project.id, text: 'one of mine is gone' });
  const order = orders.create(root, { projectId: project.id, prompt: 'the survivor' });
  orders.attachToGoal(root, order.id, goal.id, 1);
  // A plan of two whose first order is no longer on disk. goals.planned stores
  // orderIds without checking that each names anything - lib/goals says so.
  goals.planned(root, goal.id, {
    orderIds: ['ord-00000000000000-0000-vanished', order.id],
    pmAgent: 'fake',
  });

  try {
    scheduler.start(root, { intervalMs: 60000, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    assert.strictEqual(scheduler.stats().dispatched, 0,
      'the vanished order was treated as unspent and the cap admitted one too many');
    assert.strictEqual(orders.get(root, order.id).status, 'queued');
    assert.strictEqual(scheduler.stats().errors, 0,
      `the tick threw rather than skipping: ${scheduler.stats().lastError}`);
  } finally {
    await drain();
  }
});
