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
const verdict = require('../lib/verdict');

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
  await waitFor('dispatch and judges to drain', () => {
    // cancelAll() ON EVERY POLL, not once. It skips an order whose handle is
    // still null - one inside `git worktree add` - which lib/dispatch records
    // as a residual of its own: that order then passes its intent check, spawns
    // its agent AFTER the cancel, and sleeps out the shim's full timeout. A
    // single call left a 60s agent alive and timed the teardown out, which
    // surfaced as a failure in the test that had already passed its assertions.
    dispatch.cancelAll();
    // Judges hold slots too, and a judge left running by a failed test would
    // count against the next test's ceiling.
    verdict.cancelAll();
    return dispatch.inFlightCount() === 0 && verdict.inFlightCount() === 0;
  }, 30000);
  dispatch.setCapacity(null);
}

const says = (json) => `#!/bin/sh\nprintf '%s\\n' '${json}'\nexit 0\n`;
const JUDGE_VERIFY = says('{"verdict":"verified","reason":"looks right"}');
// Rejects attempt 1; verifies any attempt carrying feedback.
const JUDGE_ONCE = `#!/bin/sh
case "$2" in
  *"REVIEWER FEEDBACK"*) printf '%s\\n' '{"verdict":"verified","reason":"fixed"}' ;;
  *) printf '%s\\n' '{"verdict":"rejected","reason":"add the missing test"}' ;;
esac
exit 0
`;
const judgeTally = (tally, json, seconds = 0) =>
  shimAgent(`#!/bin/sh\necho "$$" >> "${tally}"\nsleep ${seconds}\nprintf '%s\\n' '${json}'\nexit 0\n`);

// A record the way dispatch leaves one: it RAN (startedAt set), then settled.
function settle(root, id, exitCode = 0) {
  orders.markRunning(root, id, { cwd: '/w', agent: 'fake' });
  return orders.markFinished(root, id, { exitCode });
}
function verify(root, id) {
  return orders.recordVerdict(root, id, { verdictState: 'judged', verdict: 'verified', verdictReason: 'ok' });
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
    // NOT `done`: nothing here judges (no judgeFor), and since plan 2d a goal
    // is done only when every order is VERIFIED. Exit 0 is not that claim.
    // The records settle BEFORE runOrder releases its claim (after worktree
    // cleanup), so the goal legitimately reads `running` until then - wait for
    // the claims to go, then give the sweep ticks to be wrong in.
    await waitFor('the agents to be released', () => dispatch.inFlightCount() === 0);
    await ticksPass(3, 15);
    assert.strictEqual(goals.get(root, goal.id).status, 'planned',
      'a goal was finished over orders nobody judged');
    const a = orders.get(root, made[0].id);
    const b = orders.get(root, made[1].id);

    assert.strictEqual(a.status, 'succeeded', `first order: ${a.status} ${a.error}`);
    assert.strictEqual(b.status, 'succeeded', `second order: ${b.status} ${b.error}`);
    assert.strictEqual(a.agent, 'fake');
    assert.strictEqual(scheduler.stats().offered, 2);
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
    assert.strictEqual(scheduler.stats().offered, 1);
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
    assert.strictEqual(scheduler.stats().offered, 1);
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
    assert.strictEqual(scheduler.stats().offered, 0,
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
  // concurrency 2 ASSERTED, not inherited. This is the only fixture whose kill
  // power depends on the project having a spare slot: at concurrency 1 the git
  // bound refuses the second offer before isClaimed is ever consulted, and
  // deleting the isClaimed check passes. It survived on safeConcurrency's
  // default until someone changed the default - which is one edit away from
  // shadowing the very check this test exists for.
  const project = projects.create(root, { path: repo, concurrency: 2 });
  assert.strictEqual(project.concurrency, 2,
    'this test needs a spare slot, or the project bound shadows isClaimed');
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

    assert.strictEqual(scheduler.stats().offered, 1,
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
    assert.strictEqual(scheduler.stats().offered, 1);
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
  // What boot leaves behind: every order settled AND judged, the goal still planned.
  settle(root, made[0].id); verify(root, made[0].id); settle(root, made[1].id); verify(root, made[1].id);
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
    assert.strictEqual(scheduler.stats().offered, 0);
  } finally {
    await drain();
  }
});


test('a goal whose orders all stopped during boot without a verdict is stalled by the first tick', async () => {
  // The other half of the startup sweep. An interrupted order has no result
  // and gets no verdict; only a human can move it, so the honest state is
  // `stalled` - and it must be reached at startup, synchronously, for the same
  // reason `done` is.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const { goal, made } = plannedGoal(root, project, ['one', 'two']);
  settle(root, made[0].id);
  verify(root, made[0].id);
  orders.markFailed(root, made[1].id, 'worktree: dirty tree'); // never ran
  try {
    scheduler.start(root, { intervalMs: 60000, childEnv: testEnv, agentFor: () => null });
    assert.strictEqual(goals.get(root, goal.id).status, 'stalled');
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
    assert.strictEqual(scheduler.stats().offered, 0,
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

test('a held goal\'s orders stay queued across ticks, and release lets them run', async () => {
  // Plan 3, Task 0: the review hold. Mutant: the held check removed - the
  // order is offered on the first tick and the tally gains a pid.
  // A git project, as in the planning test above: nothing else holds the
  // project, so with the check gone the agent really spawns.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const goal = goals.create(root, { projectId: project.id, text: 'read it first', hold: true });
  const order = orders.create(root, { projectId: project.id, prompt: 'held work' });
  orders.attachToGoal(root, order.id, goal.id, 0);
  goals.planned(root, goal.id, { orderIds: [order.id], pmAgent: 'fake' });
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');
  const agent = tallyShim(tally, 0);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await ticksPass(8, 15);
    assert.strictEqual(scheduler.stats().offered, 0, 'a held goal\'s order was offered');
    assert.strictEqual(pidsIn(tally).length, 0, 'an agent ran for a goal held for review');
    assert.strictEqual(orders.get(root, order.id).status, 'queued');
    // It says WHY, or a held board is indistinguishable from an idle loop.
    const skip = scheduler.stats().lastSkip;
    assert.ok(skip, 'the hold was not reported');
    assert.strictEqual(skip.reason, 'goal held for review');
    assert.strictEqual(skip.orderId, order.id);
    assert.strictEqual(goals.get(root, goal.id).status, 'planned', 'the hold moved the goal');

    goals.release(root, goal.id);
    await waitFor('the order to run once the goal is released',
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
    assert.strictEqual(scheduler.stats().offered, 0);
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
    assert.strictEqual(scheduler.stats().offered, 0);
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
    assert.strictEqual(scheduler.stats().offered, 0,
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
    assert.strictEqual(scheduler.stats().offered, 0,
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
    assert.strictEqual(scheduler.stats().offered, 2);
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
    assert.strictEqual(scheduler.stats().offered, 0);
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
    assert.strictEqual(scheduler.stats().offered, 1);
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
    assert.strictEqual(scheduler.stats().offered, 0,
      'the vanished order was treated as unspent and the cap admitted one too many');
    assert.strictEqual(orders.get(root, order.id).status, 'queued');
    assert.strictEqual(scheduler.stats().errors, 0,
      `the tick threw rather than skipping: ${scheduler.stats().lastError}`);
  } finally {
    await drain();
  }
});

test('a project that cannot produce a worktree is paused, not drained', async () => {
  // The fourth instance of the class: runOrder answers a thrown
  // worktrees.prepare with markFailed, which is right for one request and
  // ruinous for a loop. Five queued orders went from `queued` to permanently
  // `failed` in about 100ms with stats() reporting perfect health, because a
  // settle is not a refusal and nothing was counting it.
  //
  // Mutant: the pause check removed - all five burn.
  // Mutant: noteOutcome never called - same, and failedToStart stays 0.
  //
  // concurrency 1 makes the arithmetic exact: one offer per tick, so the third
  // failure arms the pause before a fourth can be offered.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo(), concurrency: 1 });
  const made = ['a', 'b', 'c', 'd', 'e'].map((p) =>
    orders.create(root, { projectId: project.id, prompt: p }));
  // A file where the worktrees directory has to go. Any systemic fault does
  // this - a full disk, a vanished project.branch, git missing - and this one
  // is deterministic: mkdirSync throws EEXIST on a path that is a file.
  fs.writeFileSync(path.join(root, 'worktrees'), 'not a directory\n');

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    await waitFor('the project to be paused', () => scheduler.stats().pausedProjects === 1);
    await ticksPass(10, 15);

    const failed = made.filter((o) => orders.get(root, o.id).status === 'failed');
    const queued = made.filter((o) => orders.get(root, o.id).status === 'queued');
    assert.strictEqual(failed.length, 3,
      `${failed.length} orders were burned before the project was paused`);
    assert.strictEqual(queued.length, 2, 'the rest were not left recoverable');
    assert.strictEqual(scheduler.stats().failedToStart, 3);
    assert.strictEqual(scheduler.stats().started, 0);
    // The half that made this invisible: a settle is not a refusal, so the
    // counter three tests rely on cannot see this class at all.
    assert.strictEqual(scheduler.stats().refused, 0);
    assert.match(orders.get(root, failed[0].id).error, /EEXIST|ENOTDIR|not a directory/i);
    // WHICH project (plan 3, Task 0): a bare count cannot tell a user looking
    // at a quiet board whether the pause is theirs.
    const ids = scheduler.stats().pausedProjectIds;
    assert.strictEqual(ids.length, 1);
    assert.strictEqual(ids[0].id, project.id);
    assert.strictEqual(ids[0].consecutive, 3);
    assert.ok(Date.parse(ids[0].until) > Date.now(), `until is not a future moment: ${ids[0].until}`);
  } finally {
    await drain();
  }
});

test('one poisoned candidate does not starve the queue behind it', async () => {
  // Mutant: the per-candidate try/catch removed.
  //
  // agentFor is caller-supplied - Task 5 writes it, out of server.js's agent
  // registry - and its documented contract says required, synchronous, may
  // return nothing. It does not say "must not throw", and it cannot: this
  // module does not own it. Without the guard, one throw abandons the whole
  // tick, and since the queue is oldest-first the poisoned order is at its head
  // on every tick forever - every healthy order in the store, on every project,
  // starved indefinitely.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo(), concurrency: 3 });
  const poison = orders.create(root, { projectId: project.id, prompt: 'poison' });
  const healthy = ['b', 'c'].map((p) => orders.create(root, { projectId: project.id, prompt: p }));
  const agent = shimAgent(OK);

  try {
    scheduler.start(root, {
      intervalMs: 15,
      childEnv: testEnv,
      agentFor: (o) => {
        if (o.id === poison.id) throw new Error('the agent registry blew up');
        return agent;
      },
    });
    await waitFor('the healthy orders to settle', () =>
      healthy.every((o) => orders.SETTLED.has(orders.get(root, o.id).status)));

    for (const o of healthy) {
      assert.strictEqual(orders.get(root, o.id).status, 'succeeded');
    }
    // The poisoned one is left where it was - not settled, not lost, and not
    // able to take anything else down with it.
    assert.strictEqual(orders.get(root, poison.id).status, 'queued');
    assert.ok(scheduler.stats().errors > 0, 'the throw was swallowed silently');
    assert.match(scheduler.stats().lastError, /agent registry blew up/);
    assert.ok(scheduler.stats().lastErrorAt, 'the error carries no timestamp');
  } finally {
    await drain();
  }
});

test('a dispatch-side fault does not cost the goal sweep', async () => {
  // Mutant: dispatchPass and reconcileGoals share one try again.
  //
  // The sweep is the one thing only this module can do - it is why lib/goals
  // grew three movers - and it ran second, inside the same try as the dispatch
  // pass. Any throw from dispatch therefore skipped it, including for goals on
  // projects that had nothing to do with the fault.
  //
  // atCapacity is thrown from deliberately: it sits at the top of the candidate
  // loop, OUTSIDE the per-candidate guard, so it is a whole-pass fault rather
  // than one candidate's.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const { goal, made } = plannedGoal(root, project, ['one', 'two']);
  orders.markFinished(root, made[0].id, { exitCode: 0 });
  orders.markFinished(root, made[1].id, { exitCode: 0 });
  // Since plan 2d `done` needs every order VERIFIED, not merely settled.
  verify(root, made[0].id); verify(root, made[1].id);
  // A queued order so the candidate loop actually enters its body.
  orders.create(root, { projectId: project.id, prompt: 'never mind me' });
  assert.strictEqual(goals.get(root, goal.id).status, 'planned');

  const realAtCapacity = dispatch.atCapacity;
  dispatch.atCapacity = () => { throw new Error('capacity oracle exploded'); };
  try {
    scheduler.start(root, { intervalMs: 60000, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    assert.strictEqual(goals.get(root, goal.id).status, 'done',
      'the goal sweep was lost to a fault on the dispatch side');
    assert.strictEqual(scheduler.stats().errors, 1);
    assert.match(scheduler.stats().lastError, /capacity oracle exploded/);
  } finally {
    dispatch.atCapacity = realAtCapacity;
    await drain();
  }
});

test('the refusal counter actually counts refusals', async () => {
  // CALIBRATION, and without it three other tests are reading a dead gauge.
  //
  // The dir-project, global-ceiling and already-claimed tests all pin their
  // advisory check by asserting `refused === 0` - correctly, because with the
  // check gone runOrder still refuses and an agent count cannot tell the two
  // apart. But every assertion in the suite is `=== 0`, so nothing ever
  // observed the counter move: replacing `if (r && r.refused)` with
  // `if (false)` left the suite green. A silent instrument that three tests
  // depend on is worse than no instrument.
  //
  // So: disable the scheduler's own guard and let runOrder's refuse for real.
  // projectBusy is patched on the module object rather than runOrder's own
  // gate, which inlines its walk of projectOf and is therefore untouched - the
  // refusal below is genuinely dispatch's.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  assert.strictEqual(project.kind, 'dir');
  const made = ['a', 'b'].map((p) => orders.create(root, { projectId: project.id, prompt: p }));
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');
  const agent = tallyShim(tally, 30);

  const realProjectBusy = dispatch.projectBusy;
  dispatch.projectBusy = () => false;
  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await waitFor('runOrder to refuse the second order', () => scheduler.stats().refused >= 1);
    // The agent is a SLOWER observable than the refusal - the refusal resolves
    // in a microtask, the spawn takes a few hundred milliseconds - so it gets
    // its own wait. Asserting it straight after the refusal read zero agents
    // and blamed the wrong thing.
    await waitFor('the first agent to record itself', () => pidsIn(tally).length >= 1);

    assert.ok(scheduler.stats().offered >= 2, 'only one order was ever offered');
    // And it keeps refusing, every tick, for as long as the first order runs -
    // 23 refusals in 360ms when measured. That is precisely the pointless work
    // the projectBusy check exists to avoid, here made visible by removing it.
    assert.ok(scheduler.stats().refused >= 1);
    // A refusal must not settle the order: it can still run once the first ends.
    assert.strictEqual(made.filter((o) => orders.get(root, o.id).status === 'queued').length, 1);
    // And still exactly one agent in the unisolated directory, because
    // runOrder - not this module - is the authority that guarantees it.
    assert.strictEqual(aliveCount(pidsIn(tally)), 1);
  } finally {
    dispatch.projectBusy = realProjectBusy;
    await drain();
  }
});

test('a hand-edited concurrency above the ceiling is clamped to it', async () => {
  // Mutant: the Math.min removed. lib/projects states the rule this follows -
  // "Ceilings, not just floors: an orderTimeoutMs of 1e15 disables the
  // stuck-agent guard exactly as effectively as 0 does" - and exports the
  // ceiling. The same hand-edited projects.json that can write a 0, which the
  // sibling test proves survives projects.get verbatim, can write 500.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo(), concurrency: 2 });
  const listed = store.readJson(root, 'projects.json', []);
  store.writeJson(root, 'projects.json',
    listed.map((p) => (p.id === project.id ? { ...p, concurrency: 500 } : p)));
  assert.strictEqual(projects.get(root, project.id).concurrency, 500);
  const max = projects.MAX_CONCURRENCY;
  assert.strictEqual(max, 8);

  const made = Array.from({ length: max + 3 }, (_, i) =>
    orders.create(root, { projectId: project.id, prompt: `order ${i}` }));
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');
  const agent = tallyShim(tally, 30);

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    // Wait on the RECORDS, not on the offer count. All eight are offered in the
    // first tick - runOrder claims synchronously - but each one only reads
    // `running` after its own `git worktree add`, and those are serialised per
    // repo. Asserting on the offer count left eight orders still reading
    // `queued` and made this look like a ceiling of one.
    const running = () => made.filter((o) => orders.get(root, o.id).status === 'running').length;
    await waitFor('the ceiling to fill', () => running() >= max);
    await ticksPass(6, 15);
    assert.strictEqual(scheduler.stats().offered, max,
      `${scheduler.stats().offered} orders offered against a ceiling of ${max}`);
    assert.strictEqual(running(), max, 'more agents than the ceiling allows');
    assert.strictEqual(made.filter((o) => orders.get(root, o.id).status === 'queued').length, 3);
  } finally {
    await drain();
  }
});

test('stats() answers what a panel has to render', async () => {
  // stats() is what Task 5 polls from a browser, so its shape is a contract:
  // O(1), no store reads, and enough to tell a healthy idle loop from a stopped
  // one, from one that errored an hour ago. `offered` is deliberately not
  // called `dispatched` - it counts attempts, and a probe once read five
  // "dispatched" while all five orders were already failed.
  const root = tmpDir('skillspace-home-');
  const before = scheduler.stats();
  assert.strictEqual(before.running, false);
  assert.strictEqual(before.intervalMs, null);

  try {
    scheduler.start(root, { intervalMs: 50, childEnv: testEnv, agentFor: () => null });
    const s = scheduler.stats();
    assert.strictEqual(s.running, true);
    assert.strictEqual(s.intervalMs, 50);
    assert.ok(s.startedAt && !Number.isNaN(Date.parse(s.startedAt)), 'startedAt is not a time');
    assert.ok(s.lastTickAt && !Number.isNaN(Date.parse(s.lastTickAt)), 'lastTickAt is not a time');
    assert.strictEqual(s.lastError, null);
    assert.strictEqual(s.lastErrorAt, null);
    assert.strictEqual(s.pausedProjects, 0);
    assert.deepStrictEqual(s.pausedProjectIds, [], "a project with no trouble is listed as paused");
    for (const k of ['ticks', 'offered', 'started', 'refused', 'failedToStart', 'errors']) {
      assert.strictEqual(typeof s[k], 'number', `${k} is missing from stats()`);
    }
    // A fresh object each call, so a caller holding one cannot mutate the
    // counters underneath the loop.
    assert.notStrictEqual(scheduler.stats(), s);
  } finally {
    await drain();
  }
  assert.strictEqual(scheduler.stats().running, false);
});

test('an agent that runs and fails is not a broken project', async () => {
  // Mutant: neverRan() drops its startedAt test and matches any `failed`.
  //
  // The breaker exists for faults that stop an order before it ever runs - a
  // worktree that cannot be created. An agent that started and exited non-zero
  // is the system working: the order failed, the project is fine, and pausing
  // it would turn a run of ordinary red builds into a scheduler that stops
  // scheduling. lib/orders draws exactly this line and this leans on it -
  // markFailed nulls startedAt, markFinished keeps whatever markRunning wrote.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo(), concurrency: 1 });
  const made = ['a', 'b', 'c', 'd'].map((p) =>
    orders.create(root, { projectId: project.id, prompt: p }));
  const agent = shimAgent('#!/bin/sh\necho "broke"\nexit 4\n');

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => agent });
    await waitFor('all four to settle', () =>
      made.every((o) => orders.SETTLED.has(orders.get(root, o.id).status)));
    // The RECORD settles before the promise does - markFinished is runOrder's
    // return expression and the cleanup finally runs after it - so the counters
    // lag the store by a cleanup. Wait for dispatch to be empty before reading
    // them, or `started` is short by however many are still tidying up.
    await waitFor('dispatch to finish accounting', () => dispatch.inFlightCount() === 0);

    for (const o of made) {
      const rec = orders.get(root, o.id);
      assert.strictEqual(rec.status, 'failed');
      assert.strictEqual(rec.exitCode, 4);
      assert.ok(rec.startedAt, 'the order never recorded a start, so this proves nothing');
    }
    assert.strictEqual(scheduler.stats().failedToStart, 0,
      'four ordinary red builds were counted as a project that cannot start orders');
    assert.strictEqual(scheduler.stats().pausedProjects, 0,
      'the project was paused for running the agents it was asked to run');
    assert.strictEqual(scheduler.stats().started, 4);
  } finally {
    await drain();
  }
});

test('one order that starts clears a run of failures to start', async () => {
  // Mutant: a started order no longer resets the breaker's counter.
  //
  // Without the reset the count is cumulative rather than CONSECUTIVE, so a
  // project that fails twice, works, then fails twice more is paused despite
  // never having been broken three times running - and since only a start
  // clears it, that pause outlives the fault entirely.
  //
  // SABOTAGED PER ORDER, not globally, and that is the whole fixture. An
  // earlier version flipped one shared fault on and off while the loop ran, and
  // it flaked 2 runs in 6 under concurrent pairs: the interval landed between
  // observing the second failure and clearing the fault, so a third failure in
  // a row armed the pause and the test hung on a state it had ruled out. There
  // is nothing to race here - which order fails is decided before start().
  //
  // worktrees.prepare refuses a dest that already exists and is not empty,
  // because its contents may be the only copy of a crashed agent's work. That
  // makes a per-order never-ran failure available without touching the repo.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo(), concurrency: 1 });
  const made = ['a', 'b', 'c', 'd', 'e'].map((p) =>
    orders.create(root, { projectId: project.id, prompt: p }));
  // Oldest first at concurrency 1, so this is the sequence: fail, fail, START,
  // fail, fail. Four failures, never three consecutively.
  for (const i of [0, 1, 3, 4]) {
    const dest = path.join(root, 'worktrees', made[i].id);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'left-behind.txt'), 'a previous run crashed here\n');
  }

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    await waitFor('all five to settle', () =>
      made.every((o) => orders.SETTLED.has(orders.get(root, o.id).status)));
    await waitFor('dispatch to finish accounting', () => dispatch.inFlightCount() === 0);

    assert.strictEqual(orders.get(root, made[2].id).status, 'succeeded',
      'the middle order did not run, so nothing ever cleared the count');
    for (const i of [0, 1, 3, 4]) {
      assert.strictEqual(orders.get(root, made[i].id).status, 'failed');
      assert.strictEqual(orders.get(root, made[i].id).startedAt, null);
    }
    assert.strictEqual(scheduler.stats().failedToStart, 4);
    assert.strictEqual(scheduler.stats().started, 1);
    assert.strictEqual(scheduler.stats().pausedProjects, 0,
      'four failures with a success in the middle paused a project that was '
      + 'never broken three times in a row');
  } finally {
    await drain();
  }
});

test('an agent binary that will not spawn pauses the project instead of draining it', async () => {
  // THE FIFTH INSTANCE, and the shape this suite never sampled: every other
  // fixture builds its agent with shimAgent(), which writes a real file and
  // chmods it. "Valid agent object, unspawnable binary" - a renamed binary, an
  // `npm i -g` window, a PATH change, an uninstall - was never put in front of
  // the loop, in either direction.
  //
  // It defeated the brake built for a failing prepare, because the fault
  // arrives one line LATER than the field that detects it: dispatch wrote
  // markRunning above the spawn, so the order settled `failed` WITH a
  // startedAt, which this module reads as "an agent existed". Every failure
  // therefore counted as a successful start and CLEARED the project's failure
  // count. Measured before the fix: twelve orders drained in two seconds,
  // pausedProjects 0, and the goal reading `done`.
  //
  // Mutant: lib/dispatch calls markFinished for a spawn that never happened.
  // Mutant: lib/runner stops reporting whether a process existed.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo(), concurrency: 1 });
  const { goal, made } = plannedGoal(root, project, ['a', 'b', 'c', 'd', 'e']);
  // A VALID agent object in every respect except that the binary is not there.
  // Nothing about this is refused by the no-agent gate - it is an object with
  // an id, a bin and buildArgs - so it reaches the spawn, which is the point.
  const ghost = {
    id: 'ghost',
    bin: path.join(tmpDir('skillspace-ghost-'), 'uninstalled-agent'),
    buildArgs: (p) => ['-p', p],
  };
  assert.ok(!fs.existsSync(ghost.bin));

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => ghost });
    await waitFor('the project to be paused', () => scheduler.stats().pausedProjects === 1);
    await ticksPass(10, 15);

    const failed = made.filter((o) => orders.get(root, o.id).status === 'failed');
    assert.strictEqual(failed.length, 3,
      `${failed.length} orders were burned by a binary that never ran`);
    assert.strictEqual(made.filter((o) => orders.get(root, o.id).status === 'queued').length, 2,
      'the rest of the backlog was not left recoverable');

    // The classification, which is what actually broke.
    assert.strictEqual(scheduler.stats().failedToStart, 3);
    assert.strictEqual(scheduler.stats().started, 0,
      'a spawn that never happened was counted as a start');

    for (const o of failed) {
      const rec = orders.get(root, o.id);
      assert.strictEqual(rec.startedAt, null,
        'the record claims an agent ran; lib/orders says a non-null startedAt means exactly that');
      assert.match(rec.error, /uninstalled-agent/, 'the failure does not name the binary');
    }
    // And the goal must not claim the work is done over five orders, three of
    // which never ran and two of which never started.
    assert.strictEqual(goals.get(root, goal.id).status, 'planned');
  } finally {
    await drain();
  }
});

test('stats() shows agents that are alive, not only ones that have finished', async () => {
  // Mutant: the inFlight gauge removed, or not maintained in the finally.
  //
  // `started` is incremented when runOrder RESOLVES - after worktrees.cleanup -
  // so it reads 0 for the entire life of every agent. At the default 15-minute
  // orderTimeoutMs a panel can show offered:4 started:0 with four agents
  // running. routes/scheduler.js renamed `dispatched` to `offered` precisely so
  // a panel would stop labelling attempts as starts; this is the same lie in
  // the other direction, and the rest of this suite never sees it because the
  // counter tests all wait for inFlightCount() === 0 first - the one moment the
  // field is honest.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  orders.create(root, { projectId: project.id, prompt: 'a long one' });
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');

  try {
    scheduler.start(root, {
      intervalMs: 15, childEnv: testEnv, agentFor: () => tallyShim(tally, 30),
    });
    await waitFor('the agent to record itself', () => pidsIn(tally).length >= 1);

    const s = scheduler.stats();
    assert.strictEqual(s.inFlight, 1, 'a live agent was invisible in stats()');
    assert.strictEqual(s.offered, 1);
    // The lie this exists beside, asserted so the relationship is pinned rather
    // than described: the agent IS running and `started` still reads zero.
    assert.strictEqual(s.started, 0);
    assert.strictEqual(aliveCount(pidsIn(tally)), 1);
  } finally {
    await drain();
  }
  // And it comes back down, or the gauge is a leak rather than a gauge.
  assert.strictEqual(scheduler.stats().inFlight, 0);
});

test('a scheduler deliberately doing nothing says so', async () => {
  // Mutant: blocked() never called on the daily-cap path.
  //
  // Twelve queued orders against a reached cap produced running:true and every
  // counter at zero, with nothing in the log - warnOnce covers unreadable
  // records, not caps - so a correctly-idle scheduler was indistinguishable
  // from a broken one. The two skips that are PERMANENT, the daily cap and the
  // per-goal budget, were the two with no observable at all.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, {
    path: tmpGitRepo(),
    budget: { maxOrdersPerDay: 1 },
  });
  const made = ['a', 'b', 'c'].map((p) => orders.create(root, { projectId: project.id, prompt: p }));

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    await ticksPass(4, 15);

    for (const o of made) {
      assert.strictEqual(orders.get(root, o.id).status, 'queued');
    }
    const s = scheduler.stats();
    assert.strictEqual(s.offered, 0);
    assert.ok(s.skipped > 0, 'nothing recorded that the loop was passing work over');
    assert.match(s.lastSkip.reason, /daily/i);
    assert.ok(made.some((o) => o.id === s.lastSkip.orderId), 'lastSkip names no real order');
    assert.ok(!Number.isNaN(Date.parse(s.lastSkip.at)), 'lastSkip carries no timestamp');
  } finally {
    await drain();
  }
});

test('a deferred candidate is not counted as a blocked one', async () => {
  // The other half, and what keeps `skipped` worth reading: a busy project, a
  // full ceiling and an order already in flight all resolve themselves within a
  // tick or two. Counting those would put thousands on the counter during
  // ordinary healthy operation and bury the two skips that never resolve.
  //
  // Mutant: blocked() called on the projectBusy or concurrency path too.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const made = ['a', 'b', 'c'].map((p) => orders.create(root, { projectId: project.id, prompt: p }));
  const tally = path.join(tmpDir('skillspace-tally-'), 'ran.txt');

  try {
    scheduler.start(root, {
      intervalMs: 15, childEnv: testEnv, agentFor: () => tallyShim(tally, 30),
    });
    await waitFor('the agent to record itself', () => pidsIn(tally).length >= 1);
    await ticksPass(8, 15);

    // Two orders passed over on every one of those ticks, all healthy.
    assert.strictEqual(made.filter((o) => orders.get(root, o.id).status === 'queued').length, 2);
    assert.strictEqual(scheduler.stats().skipped, 0,
      `an unisolated project waiting its turn was reported as blocked work: `
      + `${JSON.stringify(scheduler.stats().lastSkip)}`);
    assert.strictEqual(scheduler.stats().lastSkip, null);
  } finally {
    await drain();
  }
});

test('a goal with a malformed orderIds does not have its orders run', async () => {
  // Mutant: the Array.isArray guard in the dispatch pass removed.
  //
  // A goal's orderIds is stored unvalidated - lib/goals says so - and this loop
  // reduces over it to bound the goal's spend. Without the guard the reduce
  // throws, which the per-candidate catch turns into a skip: the order stays
  // queued and nothing is dispatched, so the two obvious assertions pass on a
  // loop that is failing on every tick forever. That is the third time this
  // exact shape has hidden a missing guard here, so this one leads with the
  // errors assertion rather than adding it as an afterthought.
  //
  // The record is written straight through store.js because goals.planned
  // refuses a non-array - which is also the only way it arises in life, a
  // hand-edited or half-written file.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const goal = goals.create(root, { projectId: project.id, text: 'bad plan' });
  const order = orders.create(root, { projectId: project.id, prompt: 'attached to nonsense' });
  orders.attachToGoal(root, order.id, goal.id, 0);
  store.writeJson(root, `goals/${goal.id}.json`,
    { ...goals.get(root, goal.id), status: 'planned', orderIds: 'not-an-array' });

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    await ticksPass(4, 15);
    assert.strictEqual(scheduler.stats().errors, 0,
      `the tick threw instead of skipping the order: ${scheduler.stats().lastError}`);
    assert.strictEqual(scheduler.stats().offered, 0,
      'an order was run for a goal whose plan cannot be read as a list');
    assert.strictEqual(orders.get(root, order.id).status, 'queued');
    assert.match(scheduler.stats().lastSkip.reason, /orderIds/);
  } finally {
    await drain();
  }
});

test('a store that cannot hold logs pauses the project too', async () => {
  // THE SECOND DOOR into the same hazard, and the one that stayed open longest
  // because a test was holding it. runner.start throws SYNCHRONOUSLY when it
  // cannot create logs/ - dispatch answered that with markFinished, which KEEPS
  // the startedAt that markRunning wrote one line earlier, so every failure
  // read as a successful start and CLEARED the breaker. Identical to the ENOENT
  // bug, by a different route, while the first route was already fixed.
  //
  // Mutant: lib/dispatch reverts to markFinished on that throw.
  //
  // Broader than the spawn case, which is why it matters: logs/ lives in the
  // store root, so a single unwritable path takes down every project at once.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo(), concurrency: 1 });
  const made = ['a', 'b', 'c', 'd', 'e'].map((p) =>
    orders.create(root, { projectId: project.id, prompt: p }));
  // logs/ as a regular file, exactly as test/dispatch.test.js does it:
  // runner.start's mkdirSync throws EEXIST before any process is spawned.
  fs.writeFileSync(path.join(root, 'logs'), 'not a directory');

  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    await waitFor('the project to be paused', () => scheduler.stats().pausedProjects === 1);
    await ticksPass(10, 15);

    const failed = made.filter((o) => orders.get(root, o.id).status === 'failed');
    assert.strictEqual(failed.length, 3,
      `${failed.length} orders were burned by a store that could not hold a log`);
    assert.strictEqual(made.filter((o) => orders.get(root, o.id).status === 'queued').length, 2,
      'the rest of the backlog was not left recoverable');
    assert.strictEqual(scheduler.stats().failedToStart, 3);
    assert.strictEqual(scheduler.stats().started, 0,
      'a dispatch that never spawned anything was counted as a start');

    for (const o of failed) {
      const rec = orders.get(root, o.id);
      assert.strictEqual(rec.startedAt, null,
        'the record claims an agent ran; runner.start threw before spawning one');
      assert.match(rec.error, /dispatch:/);
      // The evidence that dispatch got as far as markRunning is still on the
      // record - markFailed does not touch cwd - which is what makes nulling
      // startedAt a correction rather than a loss.
      assert.ok(rec.cwd, 'the order lost every trace of having reached markRunning');
    }
  } finally {
    await drain();
  }
});

test('a settled order is judged by the loop, and its goal is done only once verified', async () => {
  // Mutant A: the judge pass removed - this times out at `planned`.
  // Mutant B: goalOutcome reads `succeeded` as finished - the goal reaches
  // `done` before the verdict, and the assertion on the verdict below fails.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const { goal, made: [a] } = plannedGoal(root, project, ['one']);
  try {
    scheduler.start(root, {
      intervalMs: 15, childEnv: testEnv, agentFor: () => shimAgent(OK), judgeFor: () => shimAgent(JUDGE_VERIFY),
    });
    const g = await waitFor('the goal to be done', () => {
      const x = goals.get(root, goal.id);
      return x.status === 'done' && x;
    });
    const o = orders.get(root, a.id);
    assert.strictEqual(o.verdict, 'verified', 'done was reached without a verdict');
    assert.ok(Date.parse(g.finishedAt) >= Date.parse(o.verdictAt), 'the goal settled before its verdict');
    assert.strictEqual(scheduler.stats().judging, true);
    assert.ok(scheduler.stats().judgesOffered >= 1);
  } finally {
    await drain();
  }
});

test('a rejected attempt is retried with the reason, and the retry is judged on its own', async () => {
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const { goal, made: [a] } = plannedGoal(root, project, ['one']);
  try {
    scheduler.start(root, {
      intervalMs: 15, childEnv: testEnv, agentFor: () => shimAgent(OK), judgeFor: () => shimAgent(JUDGE_ONCE),
    });
    await waitFor('the goal to be done', () => goals.get(root, goal.id).status === 'done', 30000);
    const ids = goals.get(root, goal.id).orderIds;
    assert.strictEqual(ids.length, 2, 'exactly one retry');
    const first = orders.get(root, a.id);
    const second = orders.get(root, ids[1]);
    assert.strictEqual(first.verdict, 'rejected');
    assert.strictEqual(first.status, 'succeeded', 'the rejected attempt kept its own status');
    assert.strictEqual(second.supersedes, a.id);
    assert.strictEqual(second.verdict, 'verified');
    assert.match(second.prompt, /add the missing test/);
    assert.strictEqual(scheduler.stats().retriesCreated, 1);
  } finally {
    await drain();
  }
});

test('a chain that runs out of attempts fails the goal, and spending stops', async () => {
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo(), budget: { maxAttemptsPerOrder: 2 } });
  const { goal, made } = plannedGoal(root, project, ['one']);
  // The PM's plan is evidence, and a rejected chain must not erase it. Pins
  // markFailed over failPlanning, which would ALSO fail a planned goal - it
  // goes through patch(), which refuses only settled goals - but writes
  // rawPlan: null on the way.
  goals.planned(root, goal.id, { orderIds: made.map((o) => o.id), pmAgent: 'fake', rawPlan: 'THE-PM-PLAN' });
  const tally = path.join(tmpDir(), 'judges');
  try {
    scheduler.start(root, {
      intervalMs: 15, childEnv: testEnv, agentFor: () => shimAgent(OK),
      judgeFor: () => judgeTally(tally, '{"verdict":"rejected","reason":"still wrong"}'),
    });
    const g = await waitFor('the goal to fail', () => {
      const x = goals.get(root, goal.id);
      return x.status === 'failed' && x;
    }, 30000);
    assert.strictEqual(g.orderIds.length, 2);
    const last = orders.get(root, g.orderIds[1]);
    assert.match(last.retryRefused, /no attempts left \(2 of 2\)/);
    assert.match(g.error, new RegExp(last.id));
    assert.match(g.error, /still wrong/);
    assert.strictEqual(g.rawPlan, 'THE-PM-PLAN', "the chain's failure erased the PM's plan");
    await ticksPass(5, 15);
    assert.strictEqual(pidsIn(tally).length, 2, 'one judgement per attempt, and no more');
    assert.strictEqual(goals.get(root, goal.id).orderIds.length, 2, 'spending continued after failure');
  } finally {
    await drain();
  }
});

test('an unreadable verdict stalls the goal, and the loop never asks again', async () => {
  // Mutant: judge()'s default admission accepts `error` - the judge runs every
  // tick forever. (Admitting `error` into lib/verdict's needsVerdict alone does
  // NOT do it: judge() refuses an errored verdict unless a human asks, and that
  // refusal is the rule this pins.)
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const { goal } = plannedGoal(root, project, ['one']);
  const tally = path.join(tmpDir(), 'judges');
  try {
    scheduler.start(root, {
      intervalMs: 15, childEnv: testEnv, agentFor: () => shimAgent(OK),
      judgeFor: () => shimAgent(`#!/bin/sh\necho "$$" >> "${tally}"\necho "seems fine"\nexit 0\n`),
    });
    await waitFor('the goal to stall', () => goals.get(root, goal.id).status === 'stalled', 30000);
    await ticksPass(5, 15);
    assert.strictEqual(pidsIn(tally).length, 1);
  } finally {
    await drain();
  }
});

test('a verdict is judged before new work is dispatched', async () => {
  // A finished order waiting on its verdict holds its goal open; a fresh order
  // only adds to what is outstanding. With one slot, the verdict goes first.
  // Mutant: the judge pass runs after the dispatch pass.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const { made: [a] } = plannedGoal(root, project, ['finished']);
  settle(root, a.id);
  const { made: [b] } = plannedGoal(root, project, ['fresh']);
  dispatch.setCapacity(() => dispatch.inFlightCount() + verdict.inFlightCount() >= 1);
  try {
    scheduler.start(root, {
      intervalMs: 60000, childEnv: testEnv, agentFor: () => shimAgent(OK),
      judgeFor: () => shimAgent(`#!/bin/sh\nsleep 1\n${JUDGE_VERIFY.split('\n').slice(1).join('\n')}`),
    });
    assert.strictEqual(verdict.isJudging(a.id), true, 'the verdict was not taken first');
    assert.strictEqual(dispatch.isClaimed(b.id), false, 'the ceiling was exceeded or the order went first');
  } finally {
    await drain();
  }
});

test('orders of a goal settled before verdicts existed are not judged', async () => {
  // First boot on a 2c store must not judge its whole history.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const { goal, made } = plannedGoal(root, project, ['old one', 'old two']);
  settle(root, made[0].id);
  settle(root, made[1].id);
  goals.markDone(root, goal.id);
  const tally = path.join(tmpDir(), 'judges');
  try {
    scheduler.start(root, {
      intervalMs: 15, childEnv: testEnv, agentFor: () => null,
      judgeFor: () => judgeTally(tally, '{"verdict":"verified","reason":"x"}'),
    });
    await ticksPass(3, 15);
    assert.deepStrictEqual(pidsIn(tally), []);
    assert.strictEqual(orders.get(root, made[0].id).verdictState, null);
  } finally {
    await drain();
  }
});

test('without judgeFor nothing is judged, and the goal waits rather than finishing', async () => {
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const { goal, made: [a] } = plannedGoal(root, project, ['one']);
  settle(root, a.id);
  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => null });
    await ticksPass(3, 15);
    assert.strictEqual(scheduler.stats().judging, false, 'a panel must be able to tell verdicts are off');
    assert.strictEqual(goals.get(root, goal.id).status, 'planned');
    assert.strictEqual(orders.get(root, a.id).verdictState, null);
  } finally {
    await drain();
  }
});

test('a rejection whose retry was never created is retried by the next tick', async () => {
  // The crash shape: the verdict is on disk, the successor is not. Only the
  // tick creates successors, so this is the same path as the ordinary one.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const { goal, made: [a] } = plannedGoal(root, project, ['one']);
  settle(root, a.id);
  orders.recordVerdict(root, a.id, { verdictState: 'judged', verdict: 'rejected', verdictReason: 'needs a test' });
  try {
    scheduler.start(root, { intervalMs: 60000, childEnv: testEnv, agentFor: () => null });
    const ids = goals.get(root, goal.id).orderIds;
    assert.strictEqual(ids.length, 2);
    const next = orders.get(root, ids[1]);
    assert.strictEqual(next.supersedes, a.id);
    assert.strictEqual(next.status, 'queued');
    assert.match(next.prompt, /needs a test/);
  } finally {
    await drain();
  }
});

test('a retry held back by the daily cap waits instead of failing the goal', async () => {
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-'), budget: { maxOrdersPerDay: 1 } });
  const { goal, made: [a] } = plannedGoal(root, project, ['one']);
  settle(root, a.id);
  orders.recordVerdict(root, a.id, { verdictState: 'judged', verdict: 'rejected', verdictReason: 'r' });
  try {
    scheduler.start(root, { intervalMs: 60000, childEnv: testEnv, agentFor: () => null });
    assert.strictEqual(goals.get(root, goal.id).orderIds.length, 1);
    assert.strictEqual(orders.get(root, a.id).retryRefused, null, 'a deferral was recorded as final');
    assert.strictEqual(goals.get(root, goal.id).status, 'planned');
  } finally {
    await drain();
  }
});

test('a goal reads running while its judge is in flight', async () => {
  // Mutant: the goal sweep's busy test ignores verdict.isJudging.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const { goal, made: [a] } = plannedGoal(root, project, ['one']);
  settle(root, a.id);
  try {
    scheduler.start(root, {
      intervalMs: 15, childEnv: testEnv, agentFor: () => null,
      judgeFor: () => judgeTally(path.join(tmpDir(), 't'), '{"verdict":"verified","reason":"x"}', 2),
    });
    await waitFor('the judge to start', () => verdict.isJudging(a.id));
    await waitFor('the goal to read running', () => goals.get(root, goal.id).status === 'running');
  } finally {
    await drain();
  }
});

test('judgeFor, when given, must be a function', () => {
  const root = tmpDir('skillspace-home-');
  assert.throws(
    () => scheduler.start(root, { childEnv: testEnv, agentFor: () => null, judgeFor: 'claude' }),
    /judgeFor must be a function/
  );
  scheduler.stop();
});

test('a goal store that cannot be listed does not cost the dispatch pass', async () => {
  // Mutant: the goal list shares the tick's fate - goals.list throwing kills
  // the whole tick, and queued work that needs no goal never dispatches. The
  // inverse of 'a dispatch-side fault does not cost the goal sweep'.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  orders.create(root, { projectId: project.id, prompt: 'not part of any goal' });
  const realList = goals.list;
  goals.list = () => { throw new Error('goal store exploded'); };
  try {
    scheduler.start(root, { intervalMs: 60000, childEnv: testEnv, agentFor: () => shimAgent(OK) });
    assert.strictEqual(scheduler.stats().offered, 1, 'the dispatch pass was lost to the goal list');
    assert.match(scheduler.stats().lastError, /goal store exploded/);
  } finally {
    goals.list = realList;
    await drain();
  }
});

test('a goal whose PM is no longer installed says why it waits, instead of waiting silently', async () => {
  // judgeFor answers "not now" when the goal's pmAgent is not installed, and
  // the judge pass used to skip that silently: the goal sat at `planned`
  // forever with every counter at zero and no reason anywhere.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const { goal, made: [a] } = plannedGoal(root, project, ['one']);
  settle(root, a.id);
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warned.push(args.join(' ')); };
  try {
    scheduler.start(root, { intervalMs: 15, childEnv: testEnv, agentFor: () => null, judgeFor: () => undefined });
    await ticksPass(3, 15);
    const s = scheduler.stats();
    assert.strictEqual(s.lastSkip && s.lastSkip.reason, 'no judge available');
    assert.strictEqual(s.lastSkip.orderId, a.id);
    assert.strictEqual(warned.filter((w) => w.includes(a.id) && /judge/.test(w)).length, 1,
      'warned once, not once per tick');
    assert.strictEqual(goals.get(root, goal.id).status, 'planned');
  } finally {
    console.warn = origWarn;
    await drain();
  }
});
