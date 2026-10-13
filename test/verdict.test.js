'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const verdict = require('../lib/verdict');
const orders = require('../lib/orders');
const goals = require('../lib/goals');
const projects = require('../lib/projects');
const dispatch = require('../lib/dispatch');

// Harness copied from test/plan.test.js, helper for helper: the judge is
// lib/plan's sibling and is driven exactly the same way. No real agent runs
// anywhere in this file - every "agent" is a shell script written below.
const created = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'skillspace-vrd-'));
  created.push(d);
  return d;
}
function tmpGitRepo() {
  const d = tmpDir('skillspace-vrdrepo-');
  execSync('git init -q', { cwd: d });
  fs.writeFileSync(path.join(d, 'file.txt'), 'original\n');
  execSync('git add -A', { cwd: d });
  execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: d });
  return d;
}
function shimAgent(script) {
  const dir = tmpDir('skillspace-shim-');
  const bin = path.join(dir, 'fake-judge');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return { id: 'fake', bin, buildArgs: (p) => ['-p', p] };
}
after(() => {
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});
const testEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME });
const pidsIn = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);

// printf, never `echo -n` - test/plan.test.js records what `echo -n` cost.
const says = (json) => `#!/bin/sh\nprintf '%s\\n' '${json}'\nexit 0\n`;
const VERIFY = says('{"verdict":"verified","reason":"the file says done"}');
const REJECT = says('{"verdict":"rejected","reason":"the test was not added"}');
const PROSE = '#!/bin/sh\nprintf "\\033[31mLooks good to me.\\033[0m\\n"\nexit 0\n';
// Writes its own prompt somewhere a test can read it, then answers.
const recording = (file, json) =>
  `#!/bin/sh\nprintf '%s' "$2" > "${file}"\nprintf '%s\\n' '${json}'\nexit 0\n`;
const tallying = (tally, seconds, json) =>
  `#!/bin/sh\necho "$$" >> "${tally}"\nsleep ${seconds}\nprintf '%s\\n' '${json}'\nexit 0\n`;

// A goal order that ran and settled, with a worker log on disk - the shape
// dispatch leaves behind. `end` is what markFinished receives.
function finishedOrder(root, project, opts = {}) {
  const goal = goals.create(root, { projectId: project.id, text: 'GOAL-TEXT-MARKER the larger goal' });
  const o = orders.create(root, {
    projectId: project.id,
    prompt: opts.prompt || 'write done into file.txt',
    acceptance: opts.acceptance === undefined ? 'file.txt says done' : opts.acceptance,
  });
  orders.attachToGoal(root, o.id, goal.id, 0);
  const ids = [o.id, ...(opts.siblings || [])];
  goals.planned(root, goal.id, { orderIds: ids, pmAgent: 'fake', rawPlan: '[]' });
  orders.markRunning(root, o.id, { cwd: '/nowhere', agent: 'fake' });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(dispatch.logFileFor(root, o.id), opts.log === undefined ? 'worker said hi\n' : opts.log);
  const order = orders.markFinished(root, o.id, opts.end || { exitCode: 0 });
  return { goal: goals.get(root, goal.id), order, project };
}

function gitSetup() {
  const root = tmpDir('skillspace-home-');
  return { root, project: projects.create(root, { path: tmpGitRepo() }) };
}

test('a finished order is judged, and the verdict is recorded beside its status', async () => {
  const { root, project } = gitSetup();
  const { goal, order } = finishedOrder(root, project);
  const r = verdict.judge(root, { order, goal, project, agent: shimAgent(VERIFY), childEnv: testEnv });
  assert.strictEqual(r.refused, undefined, r.refused);
  assert.strictEqual(r.order.verdictState, 'judging', 'the claim must be on disk before the first await');
  assert.strictEqual(orders.get(root, order.id).verdictState, 'judging');

  const done = await r.done;
  assert.strictEqual(done.verdictState, 'judged');
  assert.strictEqual(done.verdict, 'verified');
  assert.strictEqual(done.verdictReason, 'the file says done');
  assert.strictEqual(done.verdictAgent, 'fake');
  assert.strictEqual(done.verdictRuns, 1);
  assert.ok(done.verdictStartedAt && done.verdictAt);
  assert.strictEqual(done.status, 'succeeded', 'a verdict must not rewrite the status');
  assert.strictEqual(done.exitCode, 0);
  assert.notStrictEqual(done.verdictLog, dispatch.logFileFor(root, order.id), 'must not append to the worker log');
  assert.match(fs.readFileSync(done.verdictLog, 'utf8'), /the file says done/, 'the judge keeps its own log');
  assert.strictEqual(verdict.inFlightCount(), 0);
});

test('a failed order still gets a verdict, timeouts included', async () => {
  // Spec 10: "PM still gets the result so a verdict exists".
  for (const [end, said] of [[{ exitCode: 2 }, /exited 2/], [{ error: 'timeout' }, /time limit/]]) {
    const { root, project } = gitSetup();
    const promptFile = path.join(tmpDir(), 'prompt.txt');
    const { goal, order } = finishedOrder(root, project, { end });
    const done = await verdict.judge(root, {
      order, goal, project, childEnv: testEnv,
      agent: shimAgent(recording(promptFile, '{"verdict":"rejected","reason":"nothing was written"}')),
    }).done;
    assert.strictEqual(done.verdict, 'rejected', JSON.stringify(end));
    assert.strictEqual(done.status, 'failed');
    assert.match(fs.readFileSync(promptFile, 'utf8'), said);
  }
});

test('an order with no result to judge is refused, and nothing is spawned', () => {
  const { root, project } = gitSetup();
  const tally = path.join(tmpDir(), 'tally');
  const agent = shimAgent(tallying(tally, 0, '{"verdict":"verified","reason":"x"}'));
  const shapes = {
    'never ran': (id) => orders.markFailed(root, id, 'worktree: dirty tree'),
    cancelled: (id) => orders.markCancelled(root, id),
  };
  for (const [name, settle] of Object.entries(shapes)) {
    const goal = goals.create(root, { projectId: project.id, text: 'g' });
    const o = orders.create(root, { projectId: project.id, prompt: 'p' });
    orders.attachToGoal(root, o.id, goal.id, 0);
    goals.planned(root, goal.id, { orderIds: [o.id], pmAgent: 'fake' });
    const order = settle(o.id);
    const r = verdict.judge(root, { order, goal: goals.get(root, goal.id), project, agent, childEnv: testEnv });
    assert.match(r.refused, /no result to judge|never ran/, name);
    assert.strictEqual(r.done, undefined, `${name}: a refusal has nothing to await`);
    assert.strictEqual(orders.get(root, o.id).verdictState, null, `${name}: a refusal settles nothing`);
  }
  // Outside a goal: there is no PM to ask.
  const loose = orders.create(root, { projectId: project.id, prompt: 'p' });
  orders.markRunning(root, loose.id, { cwd: '/x', agent: 'fake' });
  const settled = orders.markFinished(root, loose.id, { exitCode: 0 });
  assert.match(verdict.judge(root, { order: settled, goal: null, project, agent, childEnv: testEnv }).refused,
    /outside a goal/);
  assert.deepStrictEqual(pidsIn(tally), []);
});

test('an order its goal does not name, or whose goal has settled, is not judged', () => {
  // judge() is the authority for both rules; lib/verdict.pass only shadows
  // them. A settled goal is a 2c store's history, which first boot must not
  // re-judge. An order its goal does not name is a rolled-back attempt that
  // kept its goalId as a back-pointer.
  const { root, project } = gitSetup();
  const tally = path.join(tmpDir(), 'tally');
  const agent = shimAgent(tallying(tally, 0, '{"verdict":"verified","reason":"x"}'));
  const { goal, order } = finishedOrder(root, project);
  const before = orders.get(root, order.id);

  const orphanGoal = { ...goal, orderIds: ['ord-someone-else'] };
  assert.match(verdict.judge(root, { order, goal: orphanGoal, project, agent, childEnv: testEnv }).refused,
    /not part of its goal's plan/);

  goals.markDone(root, goal.id);
  const settled = goals.get(root, goal.id);
  assert.match(verdict.judge(root, { order, goal: settled, project, agent, childEnv: testEnv }).refused,
    /the goal is done/);
  assert.deepStrictEqual(orders.get(root, order.id), before, 'a refusal wrote to the record');
  assert.deepStrictEqual(pidsIn(tally), []);
});

test('unreadable output is recorded, not guessed at', async () => {
  const { root, project } = gitSetup();
  const { goal, order } = finishedOrder(root, project);
  const done = await verdict.judge(root, { order, goal, project, agent: shimAgent(PROSE), childEnv: testEnv }).done;
  assert.strictEqual(done.verdictState, 'error');
  assert.strictEqual(done.verdict, null, 'prose that sounds approving is not a verdict');
  assert.match(done.verdictError, /no JSON verdict/);
  assert.match(done.verdictRaw, /Looks good to me/, 'the raw output is the evidence');
  assert.ok(!/\u001b/.test(done.verdictRaw), 'the kept copy must be ANSI-free');

  const { root: r2, project: p2 } = gitSetup();
  const o2 = finishedOrder(r2, p2);
  const near = await verdict.judge(r2, { ...o2, agent: shimAgent(says('{"verdict":"pass","reason":"fine"}')), childEnv: testEnv }).done;
  assert.match(near.verdictError, /unrecognised verdict "pass"/);
  assert.strictEqual(near.verdict, null);
});

test('a judge that exits non-zero has given no verdict', async () => {
  // Mutant: the exit status is ignored, and a verdict printed by a crashing
  // judge is recorded as though it meant it.
  const { root, project } = gitSetup();
  const { goal, order } = finishedOrder(root, project);
  const crash = '#!/bin/sh\nprintf \'%s\\n\' \'{"verdict":"verified","reason":"x"}\'\nexit 1\n';
  const done = await verdict.judge(root, { order, goal, project, agent: shimAgent(crash), childEnv: testEnv }).done;
  assert.strictEqual(done.verdictState, 'error');
  assert.match(done.verdictError, /exited 1/);
  assert.strictEqual(done.verdict, null);
});

test('the judge is shown this order alone', async () => {
  // Spec 12, and its extension to the goal text (plan decision 9).
  const { root, project } = gitSetup();
  const sib = orders.create(root, { projectId: project.id, prompt: 'SIBLING-PROMPT', acceptance: 'SIBLING-ACCEPTANCE' });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(dispatch.logFileFor(root, sib.id), 'SIBLING-LOG\n');
  const { goal, order } = finishedOrder(root, project, { log: 'OWN-LOG-TAIL\n', siblings: [sib.id] });
  orders.attachToGoal(root, sib.id, goal.id, 1);
  const promptFile = path.join(tmpDir(), 'prompt.txt');
  await verdict.judge(root, {
    order, goal, project, childEnv: testEnv,
    agent: shimAgent(recording(promptFile, '{"verdict":"verified","reason":"ok"}')),
  }).done;
  const p = fs.readFileSync(promptFile, 'utf8');
  for (const must of ['write done into file.txt', 'file.txt says done', 'OWN-LOG-TAIL', `skillspace/${order.id}`]) {
    assert.ok(p.includes(must), `missing ${must}`);
  }
  for (const mustNot of ['SIBLING-PROMPT', 'SIBLING-ACCEPTANCE', 'SIBLING-LOG', 'GOAL-TEXT-MARKER']) {
    assert.ok(!p.includes(mustNot), `the judge saw ${mustNot}`);
  }
});

test('two judgements of one order at once spawn one judge', async () => {
  const { root, project } = gitSetup();
  const { goal, order } = finishedOrder(root, project);
  const tally = path.join(tmpDir(), 'tally');
  const agent = shimAgent(tallying(tally, 1, '{"verdict":"verified","reason":"x"}'));
  const a = verdict.judge(root, { order, goal, project, agent, childEnv: testEnv });
  const b = verdict.judge(root, { order, goal, project, agent, childEnv: testEnv });
  assert.match(b.refused, /already being judged/);
  await a.done;
  assert.strictEqual(pidsIn(tally).length, 1);
});

test('a judged verdict is never judged again, even when asked', async () => {
  const { root, project } = gitSetup();
  const { goal, order } = finishedOrder(root, project);
  await verdict.judge(root, { order, goal, project, agent: shimAgent(VERIFY), childEnv: testEnv }).done;
  const again = verdict.judge(root, {
    order, goal, project, agent: shimAgent(REJECT), childEnv: testEnv, allowFrom: [null, 'error'],
  });
  assert.match(again.refused, /already judged: verified/);
  // Not even a caller that lists 'judged' as admissible: the rule is judge()'s,
  // not the caller's.
  const insist = verdict.judge(root, {
    order, goal, project, agent: shimAgent(REJECT), childEnv: testEnv, allowFrom: ['judged', 'judging'],
  });
  assert.match(insist.refused, /already judged: verified/);
  assert.strictEqual(orders.get(root, order.id).verdict, 'verified');
});

test('an errored verdict is judged again only when someone asks', async () => {
  const { root, project } = gitSetup();
  const { goal, order } = finishedOrder(root, project);
  const first = await verdict.judge(root, { order, goal, project, agent: shimAgent(PROSE), childEnv: testEnv }).done;
  assert.strictEqual(first.verdictState, 'error');
  assert.match(verdict.judge(root, { order, goal, project, agent: shimAgent(VERIFY), childEnv: testEnv }).refused,
    /the verdict is error/, 'the default admission must not re-judge an error');
  const second = await verdict.judge(root, {
    order, goal, project, agent: shimAgent(VERIFY), childEnv: testEnv, allowFrom: [null, 'error'],
  }).done;
  assert.strictEqual(second.verdict, 'verified');
  assert.strictEqual(second.verdictRuns, 2);
  assert.strictEqual(second.verdictRaw, null, 'a successful run clears the last error\'s raw copy');
  assert.notStrictEqual(second.verdictLog, first.verdictLog, 'each run keeps its own log');
  assert.ok(fs.existsSync(first.verdictLog), 'the failed run\'s log is evidence; keep it');
});

test('a judge refused at capacity leaves the record exactly as it was', () => {
  const { root, project } = gitSetup();
  const { goal, order } = finishedOrder(root, project);
  const before = orders.get(root, order.id);
  dispatch.setCapacity(() => true);
  try {
    const r = verdict.judge(root, { order, goal, project, agent: shimAgent(VERIFY), childEnv: testEnv });
    assert.strictEqual(r.refused, 'at capacity');
    assert.strictEqual(r.kind, 'capacity');
    assert.deepStrictEqual(orders.get(root, order.id), before);
    assert.strictEqual(verdict.inFlightCount(), 0, 'a refusal must not leak a claim');
  } finally {
    dispatch.setCapacity(null);
  }
});

test('the in-flight count does not drop before the verdict is written', async () => {
  // The shutdown drain waits on this count. lib/plan learned it the hard way.
  const { root, project } = gitSetup();
  const { goal, order } = finishedOrder(root, project);
  const bad = [];
  let samples = 0;
  const probe = setInterval(() => {
    samples++;
    const o = orders.get(root, order.id);
    if (verdict.inFlightCount() === 0 && o && o.verdictState === 'judging') bad.push(o.verdictState);
  }, 1);
  const done = await verdict.judge(root, { order, goal, project, agent: shimAgent(VERIFY), childEnv: testEnv }).done;
  clearInterval(probe);
  assert.ok(samples > 20, `the probe only sampled ${samples} times`);
  assert.strictEqual(done.verdict, 'verified', 'the run did not succeed, so this proves nothing');
  assert.deepStrictEqual(bad, []);
});

test('a judge on a dir project holds the directory', async () => {
  // A dir project cannot be isolated, so the judge is one more agent in the
  // user's own tree and must be serialised with orders exactly as a PM is.
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-') });
  const { goal, order } = finishedOrder(root, project);
  const tally = path.join(tmpDir(), 'tally');
  const r = verdict.judge(root, {
    order, goal, project, childEnv: testEnv,
    agent: shimAgent(tallying(tally, 1, '{"verdict":"verified","reason":"x"}')),
  });
  assert.strictEqual(dispatch.projectBusy(project.id), true);
  await r.done;
  assert.strictEqual(dispatch.projectBusy(project.id), false, 'the claim leaked');
});

test('cancelAll stops a judge that is still preparing, before it spawns', async () => {
  const { root, project } = gitSetup();
  const { goal, order } = finishedOrder(root, project);
  const tally = path.join(tmpDir(), 'tally');
  const r = verdict.judge(root, {
    order, goal, project, childEnv: testEnv,
    agent: shimAgent(tallying(tally, 0, '{"verdict":"verified","reason":"x"}')),
  });
  assert.strictEqual(verdict.cancelAll(), 1, 'a claim with no handle yet must still be counted');
  const done = await r.done;
  assert.strictEqual(done.verdictState, 'error');
  assert.match(done.verdictError, /cancelled before it started/);
  assert.deepStrictEqual(pidsIn(tally), [], 'a judge spawned into a shutting-down process');
});

test('the log tail is the END of the worker log, bounded and ANSI-free', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'w.log');
  fs.writeFileSync(file, 'x'.repeat(100000) + '\u001b[32mGREEN\u001b[0m THE-END\n');
  const t = verdict.logTail(file);
  assert.ok(t.includes('THE-END') && t.includes('GREEN'));
  assert.ok(!t.includes('\u001b'));
  assert.ok(Array.from(t).length <= 8000);
  assert.strictEqual(verdict.logTail(path.join(dir, 'absent.log')), '');
});

// ---------- the judge waits for the work to be committed ----------
// runOrder settles the record (markFinished) BEFORE its finally commits the
// worktree onto the order branch, so a judge admitted in that window reads a
// branch without the work and judges nothing. These settle through runOrder
// itself, not through a hand-written markFinished, because the window only
// exists there.
test('an order still being wrapped up is refused by judge() and skipped by pass(), and judged once committed', async () => {
  const { root, project } = gitSetup();
  const N = 1500;
  // Enough files that cleanup's add/commit is a window a poll can land in.
  const worker = shimAgent(`#!/bin/sh\ni=0; while [ $i -lt ${N} ]; do echo $i > w$i.txt; i=$((i+1)); done\nexit 0\n`);
  const branchOf = (id) => `skillspace/${id}`;
  // The judge counts the order's committed files on its branch.
  const counter = shimAgent(`#!/bin/sh\nn=$(git -C "${project.path}" ls-tree -r --name-only "${'$'}BR" 2>/dev/null | grep -c '^w')\n` +
    `printf '{"verdict":"verified","reason":"%s files on the branch"}\\n' "$n"\nexit 0\n`);
  const goal = goals.create(root, { projectId: project.id, text: 'g' });
  const o = orders.create(root, { projectId: project.id, prompt: 'write files', acceptance: 'files exist' });
  orders.attachToGoal(root, o.id, goal.id, 0);
  goals.planned(root, goal.id, { orderIds: [o.id], pmAgent: 'fake' });
  const env = () => ({ ...testEnv(), BR: branchOf(o.id) });

  const running = dispatch.runOrder(root, { order: orders.get(root, o.id), project, agent: worker, childEnv: testEnv });
  // Wait for the window: settled on disk, still claimed by dispatch.
  let sawWindow = false;
  for (;;) {
    const cur = orders.get(root, o.id);
    if (cur.status !== 'queued' && cur.status !== 'running' && dispatch.isClaimed(o.id)) {
      sawWindow = true;
      const g = goals.get(root, goal.id);
      const r = verdict.judge(root, { order: cur, goal: g, project, agent: counter, childEnv: env });
      assert.strictEqual(r.kind, 'conflict');
      assert.match(r.refused, /still being wrapped up/);
      assert.strictEqual(orders.get(root, o.id).verdictState, null, 'a refusal writes nothing');
      const counts = verdict.pass(root, {
        all: orders.list(root), goalsById: new Map([[g.id, g]]),
        judgeFor: () => counter, childEnv: env, onError: (e) => { throw e; },
      });
      assert.deepStrictEqual(counts, { offered: 0, refused: 0 }, 'pass() must skip a claimed order, not try it');
      break;
    }
    if (!dispatch.isClaimed(o.id) && cur.status !== 'queued') break;
    await new Promise((r) => setImmediate(r));
  }
  await running;
  assert.ok(sawWindow, 'the poll never landed in the settle-to-commit window; raise N');

  const done = await verdict.judge(root, {
    order: orders.get(root, o.id), goal: goals.get(root, goal.id), project, agent: counter, childEnv: env,
  }).done;
  assert.strictEqual(done.verdictReason, `${N} files on the branch`, 'the judge saw a branch without the work');
});
