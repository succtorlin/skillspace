'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const plan = require('../lib/plan');
const goals = require('../lib/goals');
const orders = require('../lib/orders');
const projects = require('../lib/projects');
const dispatch = require('../lib/dispatch');

const created = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'skillspace-plan-'));
  created.push(d);
  return d;
}
function tmpGitRepo() {
  const d = tmpDir('skillspace-planrepo-');
  execSync('git init -q', { cwd: d });
  fs.writeFileSync(path.join(d, 'file.txt'), 'original\n');
  execSync('git add -A', { cwd: d });
  execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: d });
  return d;
}
function shimAgent(script) {
  const dir = tmpDir('skillspace-shim-');
  const bin = path.join(dir, 'fake-pm');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return { id: 'fake', bin, buildArgs: (p) => ['-p', p] };
}
after(() => {
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

const testEnv = () => ({ ...process.env });

const PLAN_OK = `#!/bin/sh
cat <<'JSON'
[{"title":"one","prompt":"do one","acceptance":"one is done"},
 {"title":"two","prompt":"do two","acceptance":"two is done"}]
JSON
exit 0
`;
const PLAN_PROSE = '#!/bin/sh\necho "I would start by reading the README."\nexit 0\n';
// printf, not `echo -n`: on macOS /bin/sh (bash 3.2 with xpg_echo) `echo -n`
// prints a literal "-n" and a newline, so this shim emitted 30 lines of prose
// and no array at all. The over-budget test then FAILED - "no JSON plan"
// matches neither alternative of /30.*12|too many/ - which is worse than it
// sounds rather than better: a red baseline makes every mutation result taken
// against it void, and a harness that scores a mutant by "did the named test
// fail?" reports M1 KILLED without the mutation having done anything. With
// printf, M1 dies on the signal it is supposed to: orders.list(...).length
// comes back 30 where 0 is expected.
const PLAN_BIG = `#!/bin/sh
printf '['
i=0
while [ $i -lt 30 ]; do
  [ $i -gt 0 ] && printf ','
  printf '{"title":"t","prompt":"p","acceptance":"a"}'
  i=$((i+1))
done
printf ']\\n'
exit 0
`;

test('the in-flight count does not drop before the goal is written', async () => {
  // What server.js's shutdown drain rests on: it exits when agentsRunning()
  // reaches 0, so a count that drops while the record is still `planning`
  // lets the process exit over a goal mid-write - the same class as the
  // orphan-at-SIGTERM bug, reached through the record instead of the process.
  //
  // The delete used to live in planWithClaim's inner `finally`, which runs
  // BEFORE the extraction, the orders.create loop and goals.planned - and the
  // worktree cleanup inside it awaits `git worktree remove`, so the window is
  // tens of milliseconds wide on a git project, not a theoretical microtask.
  // The delete is now decompose's, whose finally really does run last.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'watch the count' });

  // Sample both facts together, as fast as the loop allows, for the whole run.
  const bad = [];
  let samples = 0;
  const probe = setInterval(() => {
    samples++;
    const g = goals.get(root, goal.id);
    if (plan.inFlightCount() === 0 && g && g.status === 'planning') bad.push(g.status);
  }, 1);

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
  });
  clearInterval(probe);

  // Positive controls, both of them: a run that never sampled, or never
  // planned, would make the assertion below pass for free.
  assert.ok(samples > 20, `the probe only sampled ${samples} times`);
  assert.strictEqual(result.status, 'running', 'the plan did not succeed, so this proves nothing');
  assert.deepStrictEqual(bad, [],
    'the in-flight count reached zero while the goal was still being written');
});

test('a goal is decomposed into persisted orders', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'make it good' });

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
  });

  assert.strictEqual(result.status, 'running');
  assert.strictEqual(result.orderIds.length, 2);
  const first = orders.get(root, result.orderIds[0]);
  assert.strictEqual(first.goalId, goal.id);
  assert.strictEqual(first.seq, 0);
  assert.strictEqual(first.prompt, 'do one');
  assert.strictEqual(first.acceptance, 'one is done');
  assert.strictEqual(first.status, 'queued', 'this plan does not dispatch them');
  assert.strictEqual(orders.get(root, result.orderIds[1]).seq, 1);
  assert.strictEqual(result.pmAgent, 'fake', 'the goal must record which agent planned it');
});

test('the PM runs in an isolated worktree, not the project itself', async () => {
  // The PM is told not to modify anything, which is a hope, not a guarantee.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const agent = shimAgent(`#!/bin/sh\npwd > "${path.join(root, 'pm-cwd.txt')}"\n${PLAN_OK.split('\n').slice(1).join('\n')}`);

  await plan.decompose(root, { goal, project, agent, childEnv: testEnv });

  const cwd = fs.readFileSync(path.join(root, 'pm-cwd.txt'), 'utf8').trim();
  assert.notStrictEqual(cwd, fs.realpathSync(repo), 'the PM ran in the user\'s own tree');
  assert.match(cwd, /worktrees/);
});

test('the PM worktree is removed afterwards', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const wtRoot = path.join(root, 'worktrees');
  const left = () => (fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : []);

  const ok = goals.create(root, { projectId: project.id, text: 'x' });
  await plan.decompose(root, { goal: ok, project, agent: shimAgent(PLAN_OK), childEnv: testEnv });
  assert.deepStrictEqual(left(), [], 'a successful plan left its worktree behind');

  // A success-only cleanup passes the assertion above and still leaks a
  // worktree per failed goal, which is the whole reason the cleanup is in a
  // `finally`. Every failure return after prepare() has to be covered too, so
  // this half of the test is what actually pins it.
  const bad = goals.create(root, { projectId: project.id, text: 'y' });
  const r = await plan.decompose(root, {
    goal: bad, project, agent: shimAgent('#!/bin/sh\necho boom >&2\nexit 3\n'), childEnv: testEnv,
  });
  assert.strictEqual(r.status, 'failed');
  assert.deepStrictEqual(left(), [], 'a failed plan left its worktree behind');
});

test('unparseable output fails the goal and keeps the raw text', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_PROSE), childEnv: testEnv,
  });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /no JSON plan/);
  assert.match(result.rawPlan, /README/, 'the evidence of what the prompt produced was discarded');
  assert.strictEqual(orders.list(root, { projectId: project.id }).length, 0, 'no orders on a failed plan');
});

test('a plan over maxOrdersPerGoal fails the goal whole and dispatches nothing', async () => {
  // Spec 8a: running the first 12 of a 30-order plan produces a half-executed
  // goal that looks complete. The full plan is retained so the human can
  // narrow the goal and try again.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const base = projects.create(root, { path: repo });
  const project = { ...base, budget: { ...base.budget, maxOrdersPerGoal: 12 } };
  const goal = goals.create(root, { projectId: project.id, text: 'x' });

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_BIG), childEnv: testEnv,
  });

  assert.strictEqual(result.status, 'failed');
  // Was /30.*12|too many/. "too many" appears nowhere in the code, and a dead
  // alternative only weakens the assertion.
  assert.match(result.error, /30 orders, over the limit of 12/);
  assert.match(result.rawPlan, /title/, 'the plan must be retained so it can be narrowed');
  assert.strictEqual(orders.list(root, { projectId: project.id }).length, 0);
});

test('an impossible cap fails the goal without spawning anything', async () => {
  // goals.withinBudget honours a numeric cap literally - 0 means none allowed,
  // not unlimited - so every plan would be refused. Spending a credentialed
  // agent run to discover that is the expensive path to a knowable answer.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const base = projects.create(root, { path: repo });
  const project = { ...base, budget: { ...base.budget, maxOrdersPerGoal: 0 } };
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const marker = path.join(root, 'pm-ran.txt');
  const agent = shimAgent(`#!/bin/sh\ntouch "${marker}"\nexit 0\n`);

  const result = await plan.decompose(root, { goal, project, agent, childEnv: testEnv });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /maxOrdersPerGoal is 0/);
  assert.ok(!fs.existsSync(marker), 'the PM was spawned for a cap that can never be satisfied');

  // A present-but-non-numeric cap takes the same path: withinBudget refuses it,
  // so spawning to discover that is the same wasted run.
  const g2 = goals.create(root, { projectId: project.id, text: 'y' });
  const bad = { ...base, budget: { ...base.budget, maxOrdersPerGoal: '12' } };
  const r2 = await plan.decompose(root, { goal: g2, project: bad, agent, childEnv: testEnv });
  assert.strictEqual(r2.status, 'failed');
  assert.match(r2.error, /maxOrdersPerGoal is "12"/);
  assert.ok(!fs.existsSync(marker), 'a non-numeric cap still spawned the PM');
});

test('a budget that is not an object is refused rather than read as unlimited', async () => {
  // goals.withinBudget fails CLOSED on the budget's shape - it says so - and
  // normalising a malformed budget to {} here would hand it back the one answer
  // it refuses to give by accident: unlimited. Asked at size 1 rather than
  // re-derived, so the two can never drift apart.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const base = projects.create(root, { path: repo });
  const marker = path.join(root, 'pm-ran.txt');
  const agent = shimAgent(`#!/bin/sh\ntouch "${marker}"\n${PLAN_OK.split('\n').slice(1).join('\n')}`);

  // Arrays are in this list deliberately: [] and [1] are objects, so a guard
  // written as `typeof budget === 'object'` lets them through to be read as an
  // absent cap, i.e. unlimited. withinBudget refuses them; so must this.
  const shapes = [
    [0, /the budget is 0/],
    ['12', /the budget is "12"/],
    [[], /the budget is \[\]/],
    [[1], /the budget is \[1\]/],
    [false, /the budget is false/],
    [NaN, /the budget is NaN/],
  ];
  for (const [budget, expected] of shapes) {
    const goal = goals.create(root, { projectId: base.id, text: 'x' });
    const result = await plan.decompose(root, {
      goal, project: { ...base, budget }, agent, childEnv: testEnv,
    });
    assert.strictEqual(result.status, 'failed', `budget ${String(budget)} was accepted`);
    assert.match(result.error, /no plan can be accepted/);
    // The refusal is the only place these shapes ever surface, so it has to
    // name the one it got. String([]) is '' and String([1]) is '1' - an array
    // would otherwise report as a blank message or as a plain number.
    assert.match(result.error, expected);
  }
  assert.ok(!fs.existsSync(marker), 'a malformed budget still spawned the PM');
  assert.strictEqual(orders.list(root, { projectId: base.id }).length, 0);
});

test('a PM that exits non-zero fails the goal with its output', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const agent = shimAgent('#!/bin/sh\necho "model overloaded" >&2\nexit 3\n');

  const result = await plan.decompose(root, { goal, project, agent, childEnv: testEnv });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /exit(ed)? 3|exit code 3/);
  assert.match(result.rawPlan, /overloaded/);

  // A PM that printed a plan and THEN died is the case where dropping the exit
  // check stops enforcing anything: the plan parses, so extraction succeeds and
  // the goal runs on the output of a run that did not finish.
  const g2 = goals.create(root, { projectId: project.id, text: 'y' });
  const crashed = shimAgent(`${PLAN_OK.replace('exit 0', '')}echo "then it died" >&2\nexit 1\n`);
  const r2 = await plan.decompose(root, { goal: g2, project, agent: crashed, childEnv: testEnv });
  assert.strictEqual(r2.status, 'failed', 'a plan from a crashed PM was accepted');
  assert.match(r2.error, /exit(ed)? 1/);
  assert.strictEqual(orders.list(root, { projectId: project.id }).length, 0);
});

test('a missing agent fails the goal without creating a worktree', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });

  const result = await plan.decompose(root, { goal, project, agent: null, childEnv: testEnv });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /agent/);
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], []);
});

test('a missing childEnv policy fails the goal without spawning anything', async () => {
  // Same contract as dispatch: the only sensible default is process.env, which
  // is the credential leak the allowlist exists to prevent.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const marker = path.join(root, 'pm-ran.txt');
  const agent = shimAgent(`#!/bin/sh\ntouch "${marker}"\nexit 0\n`);

  for (const childEnv of [undefined, null, {}, 'process.env', true]) {
    const g = goals.create(root, { projectId: project.id, text: 'x' });
    const result = await plan.decompose(root, { goal: g, project, agent, childEnv });
    assert.strictEqual(result.status, 'failed', `childEnv ${String(childEnv)} was accepted`);
    assert.match(result.error, /child environment/);
  }
  // A truthy non-function is the drift that matters: `!childEnv` would let an
  // object through, and the runner falls back to process.env for anything that
  // is not a usable env - which is the leak, arriving by a different door.
  assert.ok(!fs.existsSync(marker), 'the PM was spawned with no environment policy');
});

test('a plan wrapped in ANSI colour still extracts', async () => {
  // ESC[32m contains a '[', and arraySpans counts brackets - one colour code
  // swallows the plan. Agent CLIs emit colour by default, so this is the
  // common case rather than an edge case.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const agent = shimAgent(
    '#!/bin/sh\nprintf \'\\033[32mHere is the plan:\\033[0m\\n\'\n' +
    'cat <<\'JSON\'\n[{"title":"one","prompt":"do one","acceptance":"a"}]\nJSON\nexit 0\n'
  );

  const result = await plan.decompose(root, { goal, project, agent, childEnv: testEnv });

  assert.strictEqual(result.status, 'running', `colour broke extraction: ${result.error}`);
  assert.strictEqual(result.orderIds.length, 1);
});

test('a plan that cannot be persisted leaves no orphaned orders', async () => {
  // orders.create throws on a caller fault mid-loop; the orders already written
  // must not survive as invisible work a scheduler could pick up.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const real = orders.create;
  let n = 0;
  orders.create = (...args) => {
    if (++n === 2) throw new Error('prompt is too long (100001 > 100000)');
    return real(...args);
  };
  try {
    const result = await plan.decompose(root, {
      goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
    });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.error, /could not persist the plan/);
    const live = orders.list(root, { projectId: project.id })
      .filter((o) => o.status !== 'cancelled');
    assert.deepStrictEqual(live, [], 'orphaned orders survived a failed plan');
  } finally {
    orders.create = real;
  }
});

test('an order created but not yet attached is still rolled back', async () => {
  // The orphan the create-loop catch is really guarding: attachToGoal throws
  // AFTER orders.create has already written the record. If the id is recorded
  // only once attaching succeeds, that order survives the rollback as a
  // `queued` record with goalId null - work no goal points at, which a
  // scheduler would nonetheless be free to run.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const real = orders.attachToGoal;
  let n = 0;
  orders.attachToGoal = (...args) => {
    if (++n === 2) throw new Error('seq must be a non-negative integer, got null');
    return real(...args);
  };
  try {
    const result = await plan.decompose(root, {
      goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
    });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.error, /could not persist the plan/);
    const live = orders.list(root, { projectId: project.id })
      .filter((o) => o.status !== 'cancelled');
    assert.deepStrictEqual(
      live.map((o) => ({ id: o.id, goalId: o.goalId, status: o.status })), [],
      'an order created but not attached escaped the rollback'
    );
  } finally {
    orders.attachToGoal = real;
  }
});

test('a rollback that cannot cancel says so on the goal', async () => {
  // If the store is refusing writes, the rollback leaves orders `queued` with a
  // goalId pointing at a goal about to be marked failed - the exact invisible
  // work the rollback exists to prevent. The goal's error is the only place a
  // human would ever see it, so an empty catch there is a silent data problem.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const realCreate = orders.create;
  const realCancel = orders.markCancelled;
  let n = 0;
  orders.create = (...a) => {
    if (++n === 2) throw new Error('prompt is too long (100001 > 100000)');
    return realCreate(...a);
  };
  orders.markCancelled = () => { throw new Error('EROFS: read-only file system'); };
  try {
    const result = await plan.decompose(root, {
      goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
    });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.error, /could not persist the plan/);
    assert.match(
      result.error, /1 order\(s\) could not be cancelled and are still queued/,
      'the rollback failed silently and the goal says nothing about it'
    );
  } finally {
    orders.create = realCreate;
    orders.markCancelled = realCancel;
  }
});

test('a caller-supplied onChunk still receives the output', async () => {
  // Capturing internally must not steal the stream plan 3's live log needs.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  let seen = '';

  await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
    onChunk: (c) => { seen += c; },
  });

  assert.match(seen, /title/, 'the caller\'s onChunk was not called');
});

test('a header line already in the log does not reach the extractor', async () => {
  // The runner opens the log in append mode and a caller may have written a
  // header into it. Reading the file back would feed that to the extractor.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const logFile = plan.logFileFor(root, goal.id);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, '=== header [{"title":"ghost","prompt":"p"}] ===\n');

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
  });

  assert.strictEqual(result.status, 'running');
  assert.strictEqual(result.orderIds.length, 2, 'a plan from the header leaked in');
  assert.strictEqual(orders.get(root, result.orderIds[0]).title, 'one');
  // The order-count assertions above CANNOT tell the two sources apart on this
  // input: the header's array is first in the file, so "the last plausible
  // array wins" picks the real plan either way. What the log-reading version
  // cannot do is keep the goal's evidence clean - rawPlan is supposed to be
  // what the PM said, not what happened to be lying in the log file.
  assert.doesNotMatch(result.rawPlan, /ghost/, 'the log file\'s contents were kept as the PM\'s output');
  assert.doesNotMatch(result.rawPlan, /=== header/, 'the log file was read back instead of the stream');
});

test('output past the capture cap fails the goal rather than being parsed', async () => {
  // The cap is a runaway guard, and the tail of a runaway transcript can parse
  // perfectly well - so a plan extracted from a truncated capture would be a
  // plan the PM never finished writing. Refuse instead, and keep what arrived.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  // 11.5 MB of filler, then a perfectly valid one-order plan at the very end.
  const agent = shimAgent(
    '#!/bin/sh\ni=0\nwhile [ $i -lt 44 ]; do\n'
    + '  head -c 262144 /dev/zero | tr \'\\0\' \'a\'\n  i=$((i+1))\ndone\n'
    + 'printf \'\\n[{"title":"t","prompt":"p","acceptance":"a"}]\\n\'\nexit 0\n'
  );

  let forwarded = 0;
  const result = await plan.decompose(root, {
    goal, project, agent, childEnv: testEnv, onChunk: (c) => { forwarded += c.length; },
  });

  assert.strictEqual(result.status, 'failed', 'a plan was extracted from a runaway transcript');
  assert.match(result.error, /more than 10485760/);
  assert.strictEqual(orders.list(root, { projectId: project.id }).length, 0);
  // CAPTURE_CAP bounds what THIS module holds, not what the caller sees. A live
  // log that goes silent at 10MB looks like an agent that stopped.
  assert.ok(forwarded > 11 * 1024 * 1024, `caller saw only ${forwarded} bytes past the cap`);
  // Exactly the cap, not "the cap plus whatever the overflowing chunk carried".
  // The number in the error message is the number that was kept, or the record
  // says something the code did not do.
  assert.strictEqual(result.rawPlan.length, 10 * 1024 * 1024);
});

test('a PM that times out fails the goal on the timeout, not on what it printed', async () => {
  // A killed run's output can parse perfectly well - the plan may be complete
  // on stdout and the agent still hung afterwards. Extracting from it accepts
  // work from a run we terminated, and the goal then reads as planned.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const base = projects.create(root, { path: repo });
  const project = { ...base, budget: { ...base.budget, orderTimeoutMs: 250 } };
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const agent = shimAgent(`${PLAN_OK.replace('exit 0', '')}sleep 30\n`);

  const result = await plan.decompose(root, { goal, project, agent, childEnv: testEnv });

  assert.strictEqual(result.status, 'failed', 'a plan from a timed-out PM was accepted');
  assert.match(result.error, /timeout/);
  assert.strictEqual(orders.list(root, { projectId: project.id }).length, 0);
});

test('a worktree that cannot be prepared fails the goal instead of escaping', async () => {
  // A throw out of decompose leaves the goal in `planning`, which nothing in
  // this plan moves on - only reconcile() at the next boot clears it. The
  // caller has to get an outcome, not an exception.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  // What a previous crashed run of this id leaves behind. worktrees.prepare
  // refuses it rather than deleting what may be the only copy of that work.
  const dest = path.join(root, 'worktrees', goal.id);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'leftover.txt'), 'from a crashed run');

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
  });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /worktree/);
  assert.strictEqual(goals.get(root, goal.id).status, 'failed', 'the goal was left in planning');
  assert.ok(fs.existsSync(path.join(dest, 'leftover.txt')), 'the crashed run\'s work was deleted');
});

test('the PM is asked not to colour its output', async () => {
  // Belt and braces with stripAnsi: NO_COLOR and TERM=dumb are the request, and
  // stripping is what happens when a CLI ignores it. The request is worth
  // pinning on its own - a caller-supplied childEnv must not be able to
  // reinstate colour by omission, and childEnv is spread FIRST for that reason.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const out = path.join(root, 'child-env.txt');
  const agent = shimAgent(
    `#!/bin/sh\nprintf 'NO_COLOR=%s TERM=%s\\n' "$NO_COLOR" "$TERM" > "${out}"\n`
    + `${PLAN_OK.split('\n').slice(1).join('\n')}`
  );

  await plan.decompose(root, {
    goal, project, agent, childEnv: () => ({ ...process.env, TERM: 'xterm-256color' }),
  });

  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'NO_COLOR=1 TERM=dumb');
});

test('two concurrent goals on one dir project do not both run in it', async () => {
  // worktrees.prepare states this in the imperative and names the incident:
  // "a caller that skips that check gets two agents in the user's own tree,
  // which is what happened while this comment claimed the caller already
  // handled it." A dir project has no isolation mechanism at all.
  const root = tmpDir('skillspace-home-');
  const work = tmpDir('skillspace-work-');
  const project = projects.create(root, { path: work });
  assert.strictEqual(project.kind, 'dir');
  const marks = path.join(root, 'concurrent.txt');
  // Records its own entry and exit, so overlap is visible in the file order.
  const agent = shimAgent(
    `#!/bin/sh\necho in >> "${marks}"\nsleep 1\necho out >> "${marks}"\n`
    + `${PLAN_OK.split('\n').slice(1).join('\n')}`
  );
  const g1 = goals.create(root, { projectId: project.id, text: 'one' });
  const g2 = goals.create(root, { projectId: project.id, text: 'two' });

  const [r1, r2] = await Promise.all([
    plan.decompose(root, { goal: g1, project, agent, childEnv: testEnv }),
    plan.decompose(root, { goal: g2, project, agent, childEnv: testEnv }),
  ]);

  const statuses = [r1.status, r2.status].sort();
  assert.deepStrictEqual(statuses, ['failed', 'running'], 'both PMs ran in the user\'s directory');
  const refused = r1.status === 'failed' ? r1 : r2;
  assert.match(refused.error, /project busy/);
  // The interleaving is the property, not the count: "in in out out" is two
  // agents in one directory at one moment.
  assert.deepStrictEqual(fs.readFileSync(marks, 'utf8').trim().split('\n'), ['in', 'out']);
});

test('a dispatched order and a PM cannot both run in one dir project', async () => {
  // One pool, not two: lib/plan claims from dispatch's registry, so each spawn
  // path can see the other. A second registry would have left this exact gap.
  const root = tmpDir('skillspace-home-');
  const work = tmpDir('skillspace-work-');
  const project = projects.create(root, { path: work });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });

  // Stand in for a dispatched order holding the claim.
  dispatch.claimProject('ord-standin', project.id);
  try {
    const result = await plan.decompose(root, {
      goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
    });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.error, /project busy/);
  } finally {
    dispatch.releaseProject('ord-standin');
  }
  // And the claim is released again, so the next goal is not locked out.
  const g2 = goals.create(root, { projectId: project.id, text: 'y' });
  const ok = await plan.decompose(root, {
    goal: g2, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
  });
  assert.strictEqual(ok.status, 'running', 'the PM claim leaked and locked the project');
  assert.strictEqual(dispatch.projectBusy(project.id), false, 'the claim was never released');
});

test('a running PM is visible to shutdown and can be cancelled', async () => {
  // The fourth spawn path. Agents run detached, so a signal to the server's
  // group never reaches them, and the timeout that bounds them is a setTimeout
  // in the server process that dies with it. A PM missing from the registry is
  // a credentialed agent reparented to init with no bound at all.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const started = path.join(root, 'pm-started.txt');
  const agent = shimAgent(`#!/bin/sh\ntouch "${started}"\nsleep 60\n`);

  assert.strictEqual(plan.inFlightCount(), 0);
  const running = plan.decompose(root, { goal, project, agent, childEnv: testEnv });

  // Wait for the child to actually exist before asserting on the pool.
  for (let i = 0; i < 200 && !fs.existsSync(started); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(fs.existsSync(started), 'the PM never started');
  assert.strictEqual(plan.inFlightCount(), 1, 'a live PM is invisible to shutdown');

  assert.strictEqual(plan.cancelAll(), 1, 'cancelAll did not reach the PM');
  const result = await running;
  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /cancelled/);
  // Counted to zero only once the goal is on disk, so a shutdown drain waiting
  // on this waits for the record, not merely for the child to exit.
  assert.strictEqual(plan.inFlightCount(), 0);
});

test('a goal that vanished mid-run persists no orders and returns null', async () => {
  // store.js quarantines a record it cannot parse, and a delete route is the
  // obvious next thing to exist. Fifteen minutes pass inside a real run.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const agent = shimAgent(
    `#!/bin/sh\nrm -f "${path.join(root, 'goals', `${'$'}{0##*/}`)}"\n`
    + `${PLAN_OK.split('\n').slice(1).join('\n')}`
  );
  // Delete it out from under the run, which is what a quarantine does.
  const gone = shimAgent(
    `#!/bin/sh\nrm -f "${path.join(root, 'goals', goal.id + '.json')}"\n`
    + `${PLAN_OK.split('\n').slice(1).join('\n')}`
  );
  void agent;

  const result = await plan.decompose(root, { goal, project, agent: gone, childEnv: testEnv });

  assert.strictEqual(result, null, 'a caller doing result.status here gets a TypeError');
  assert.strictEqual(
    orders.list(root, { projectId: project.id }).length, 0,
    'orders were attached to a goal that no longer exists'
  );
});

test('a goal settled mid-run is not overwritten and gains no orders', async () => {
  // goals.patch silently no-ops on a settled record, so goals.planned would
  // report success while writing nothing - leaving queued orders carrying the
  // goalId of a goal that already failed.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const agent = shimAgent(
    `#!/bin/sh\nsleep 0.2\n${PLAN_OK.split('\n').slice(1).join('\n')}`
  );

  const running = plan.decompose(root, { goal, project, agent, childEnv: testEnv });
  await new Promise((r) => setTimeout(r, 60));
  goals.failPlanning(root, goal.id, 'cancelled by the human', null);

  const result = await running;

  assert.strictEqual(result.status, 'failed', 'a settled goal was reported as planned');
  assert.strictEqual(result.error, 'cancelled by the human', 'the settled record was overwritten');
  assert.strictEqual(
    orders.list(root, { projectId: project.id }).length, 0,
    'orders were persisted for a goal that had already settled'
  );
});

test('a PM whose log cannot be opened fails the goal instead of rejecting', async () => {
  // runner.start throws SYNCHRONOUSLY on an unwritable log directory. dispatch
  // catches exactly this. Without it the goal is left `planning`, which only
  // reconcile() at the next boot clears.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  // A FILE where the logs directory has to go.
  fs.writeFileSync(path.join(root, 'logs'), 'not a directory');

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
  });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /pm could not start/);
  assert.strictEqual(goals.get(root, goal.id).status, 'failed', 'the goal was left in planning');
});

test('a childEnv that throws fails the goal instead of rejecting', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_OK),
    childEnv: () => { throw new Error('no credentials configured'); },
  });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /pm could not start: no credentials configured/);
});

test('a clean PM run leaves no branch behind; one that wrote files keeps it', async () => {
  // worktrees.cleanup keeps the branch unconditionally, which is right for an
  // order - the branch IS its durable record. A PM's record is the plan on
  // stdout, so a branch per goal is pollution. Unless the PM disobeyed "do NOT
  // modify any files", in which case the branch is the evidence.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const branches = () => execSync('git branch --list "skillspace/*"', { cwd: repo, encoding: 'utf8' })
    .split('\n').map((l) => l.replace(/^[* ]+/, '').trim()).filter(Boolean);

  for (let i = 0; i < 3; i++) {
    const g = goals.create(root, { projectId: project.id, text: `clean ${i}` });
    const r = await plan.decompose(root, { goal: g, project, agent: shimAgent(PLAN_OK), childEnv: testEnv });
    assert.strictEqual(r.status, 'running');
  }
  assert.deepStrictEqual(branches(), [], 'a branch per goal accumulated in the user\'s repo');

  const dirty = goals.create(root, { projectId: project.id, text: 'writes a file' });
  const writer = shimAgent(
    `#!/bin/sh\necho meddled > meddled.txt\n${PLAN_OK.split('\n').slice(1).join('\n')}`
  );
  const r = await plan.decompose(root, { goal: dirty, project, agent: writer, childEnv: testEnv });
  assert.strictEqual(r.status, 'running');
  assert.deepStrictEqual(
    branches(), [`skillspace/${dirty.id}`],
    'the PM modified files and the evidence was deleted'
  );
});

test('a PM cancelled before it spawns never spawns', async () => {
  // The two-phase claim puts a NULL in the map before `await worktrees.prepare`,
  // and cancelAll() used to skip a null handle - so inside that window the count
  // said 1 while the cancel said 0. The drain then noticed the PM, waited its
  // six seconds, and exited over a credentialed agent that spawned afterwards
  // into a dying process, reparented to init with no time bound.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const started = path.join(root, 'pm-started.txt');
  const agent = shimAgent(`#!/bin/sh\ntouch "${started}"\nsleep 60\n`);

  const running = plan.decompose(root, { goal, project, agent, childEnv: testEnv });
  // setImmediate lands inside the prepare window - a rev-parse plus a
  // `worktree add`. A wall-clock delay can only hit it by luck.
  const cancelled = await new Promise((r) => setImmediate(() => {
    const counted = plan.inFlightCount();
    const n = plan.cancelAll();
    r({ counted, n });
  }));

  assert.strictEqual(cancelled.counted, 1, 'the claim was not visible to shutdown');
  assert.strictEqual(cancelled.n, 1, 'a claimed-but-unspawned PM was skipped by cancelAll');

  const result = await running;
  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /cancelled before it started/);
  assert.ok(!fs.existsSync(started), 'the PM spawned after it had been cancelled');
  // And it takes nothing with it: the worktree and its branch are cleaned up on
  // this return exactly as on any other.
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], []);
  assert.strictEqual(
    execSync('git branch --list "skillspace/*"', { cwd: repo, encoding: 'utf8' }).trim(), ''
  );
  assert.strictEqual(plan.inFlightCount(), 0);
});

test('a goal settled during prepare does not spawn an agent', async () => {
  // dispatch.runOrder re-reads its record at exactly this point - "check intent
  // before starting an agent nothing can then stop". Measured against dispatch
  // for the same window before this landed: an order cancelled during prepare
  // spawned nothing, a goal failed during prepare spawned a PM anyway.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const started = path.join(root, 'pm-started.txt');
  const agent = shimAgent(`#!/bin/sh\ntouch "${started}"\n${PLAN_OK.split('\n').slice(1).join('\n')}`);

  const running = plan.decompose(root, { goal, project, agent, childEnv: testEnv });
  await new Promise((r) => setImmediate(() => {
    goals.failPlanning(root, goal.id, 'the human changed their mind', null);
    r();
  }));
  const result = await running;

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.error, 'the human changed their mind', 'the settled record was overwritten');
  assert.ok(!fs.existsSync(started), 'a PM spawned for an already-settled goal');
  assert.strictEqual(orders.list(root, { projectId: project.id }).length, 0);
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], []);
});

test('a goal deleted during prepare does not spawn an agent and returns null', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const started = path.join(root, 'pm-started.txt');
  const agent = shimAgent(`#!/bin/sh\ntouch "${started}"\n${PLAN_OK.split('\n').slice(1).join('\n')}`);

  const running = plan.decompose(root, { goal, project, agent, childEnv: testEnv });
  await new Promise((r) => setImmediate(() => {
    fs.rmSync(path.join(root, 'goals', `${goal.id}.json`), { force: true });
    r();
  }));
  const result = await running;

  assert.strictEqual(result, null, 'a caller doing result.status here gets a TypeError');
  assert.ok(!fs.existsSync(started), 'a PM spawned for a goal that no longer exists');
  assert.strictEqual(orders.list(root, { projectId: project.id }).length, 0);
});

test('a dir project plans in place and its files survive', async () => {
  const root = tmpDir('skillspace-home-');
  const work = tmpDir('skillspace-work-');
  fs.writeFileSync(path.join(work, 'keep.txt'), 'precious');
  const project = projects.create(root, { path: work });
  assert.strictEqual(project.kind, 'dir');
  const goal = goals.create(root, { projectId: project.id, text: 'x' });

  const cwdFile = path.join(root, 'pm-cwd.txt');
  const agent = shimAgent(
    `#!/bin/sh\npwd > "${cwdFile}"\n${PLAN_OK.split('\n').slice(1).join('\n')}`
  );

  const result = await plan.decompose(root, { goal, project, agent, childEnv: testEnv });

  assert.strictEqual(result.status, 'running');
  // "in place" was the name of this test and the one thing it never checked:
  // both assertions below hold just as well if the PM ran in a worktree.
  assert.strictEqual(
    fs.readFileSync(cwdFile, 'utf8').trim(), fs.realpathSync(work),
    'a dir project has no isolation mechanism; the PM must run in the directory itself'
  );
  assert.ok(fs.existsSync(path.join(work, 'keep.txt')), 'a dir project must never be cleaned up');
});
