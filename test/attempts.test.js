'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const attempts = require('../lib/attempts');
const orders = require('../lib/orders');
const goals = require('../lib/goals');
const projects = require('../lib/projects');

const created = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'skillspace-att-'));
  created.push(d);
  return d;
}
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

// No agents anywhere in this file: supersede() is pure bookkeeping over the
// store, and every verdict below is written directly.
function setup(budget) {
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpDir('skillspace-work-'), budget });
  return { root, project };
}

function goalWith(root, project, n = 1) {
  const goal = goals.create(root, { projectId: project.id, text: 'g' });
  const made = [];
  for (let i = 0; i < n; i++) {
    const o = orders.create(root, {
      projectId: project.id, title: `T${i}`, prompt: `do part ${i}`, acceptance: `part ${i} is done`,
    });
    orders.attachToGoal(root, o.id, goal.id, i);
    made.push(o);
  }
  goals.planned(root, goal.id, { orderIds: made.map((o) => o.id), pmAgent: 'fake' });
  return { goal, made };
}

function reject(root, id, reason = 'the test was not added') {
  orders.markRunning(root, id, { cwd: '/w', agent: 'fake' });
  orders.markFinished(root, id, { exitCode: 0 });
  return orders.recordVerdict(root, id, { verdictState: 'judged', verdict: 'rejected', verdictReason: reason });
}

test('a rejected order is superseded by a new one carrying the reason', () => {
  const { root, project } = setup();
  const { goal, made: [a] } = goalWith(root, project);
  reject(root, a.id);
  const before = orders.get(root, a.id);

  const r = attempts.supersede(root, { orderId: a.id, origin: 'verdict' });
  assert.strictEqual(r.refused, undefined, r.refused);
  const b = r.order;
  assert.strictEqual(b.supersedes, a.id);
  assert.strictEqual(b.status, 'queued');
  assert.strictEqual(b.goalId, goal.id);
  assert.strictEqual(b.seq, 0, 'an attempt keeps its place in the plan');
  assert.strictEqual(b.title, 'T0');
  assert.strictEqual(b.acceptance, 'part 0 is done', 'the criteria do not change between attempts');
  assert.ok(b.prompt.startsWith('do part 0'), 'the instruction is kept, not rewritten');
  assert.match(b.prompt, /REVIEWER FEEDBACK ON ATTEMPT 1[\s\S]*the test was not added[\s\S]*attempt 2/);
  assert.deepStrictEqual(goals.get(root, goal.id).orderIds, [a.id, b.id]);
  assert.deepStrictEqual(orders.get(root, a.id), before, 'the rejected order was touched');
});

test('an order is superseded at most once', () => {
  const { root, project } = setup();
  const { goal, made: [a] } = goalWith(root, project);
  reject(root, a.id);
  const first = attempts.supersede(root, { orderId: a.id, origin: 'verdict' });
  const second = attempts.supersede(root, { orderId: a.id, origin: 'human' });
  assert.match(second.refused, /already superseded by/);
  assert.strictEqual(second.supersededBy, first.order.id);
  assert.strictEqual(goals.get(root, goal.id).orderIds.length, 2);
});

test('the attempt cap ends an automatic chain, and says how far it got', () => {
  const { root, project } = setup({ maxAttemptsPerOrder: 2 });
  const { made: [a] } = goalWith(root, project);
  reject(root, a.id, 'first reason');
  const b = attempts.supersede(root, { orderId: a.id, origin: 'verdict' }).order;
  reject(root, b.id, 'second reason');
  const r = attempts.supersede(root, { orderId: b.id, origin: 'verdict' });
  assert.strictEqual(r.kind, 'final');
  assert.match(r.refused, /no attempts left \(2 of 2\)/);
});

test('feedback accumulates across attempts', () => {
  const { root, project } = setup();
  const { made: [a] } = goalWith(root, project);
  reject(root, a.id, 'REASON-ONE');
  const b = attempts.supersede(root, { orderId: a.id, origin: 'verdict' }).order;
  reject(root, b.id, 'REASON-TWO');
  const c = attempts.supersede(root, { orderId: b.id, origin: 'verdict' }).order;
  assert.match(c.prompt, /REASON-ONE[\s\S]*REASON-TWO[\s\S]*attempt 3/);
});

test('retries count against maxOrdersPerGoal, and reaching it is final', () => {
  const { root, project } = setup({ maxOrdersPerGoal: 2 });
  const { goal, made: [a] } = goalWith(root, project, 2);
  reject(root, a.id);
  const r = attempts.supersede(root, { orderId: a.id, origin: 'verdict' });
  assert.strictEqual(r.kind, 'final');
  assert.match(r.refused, /used its 2 orders/);
  assert.strictEqual(goals.get(root, goal.id).orderIds.length, 2, 'nothing was added');
});

test('a reached daily cap defers a retry instead of ending the chain', () => {
  // The scheduler's rule for the cap: the backlog waits for tomorrow.
  const { root, project } = setup({ maxOrdersPerDay: 1 });
  const { made: [a] } = goalWith(root, project);
  reject(root, a.id);
  const r = attempts.supersede(root, { orderId: a.id, origin: 'verdict' });
  assert.strictEqual(r.kind, 'limit');
  assert.match(r.refused, /daily limit reached \(1 orders\)/);
});

test('a human retry ignores the attempt cap and nothing else', () => {
  const { root, project } = setup({ maxAttemptsPerOrder: 1, maxOrdersPerGoal: 3 });
  const { made: [a] } = goalWith(root, project);
  reject(root, a.id);
  assert.strictEqual(attempts.supersede(root, { orderId: a.id, origin: 'verdict' }).kind, 'final');
  const h = attempts.supersede(root, { orderId: a.id, origin: 'human' });
  assert.ok(h.order, h.refused);
  reject(root, h.order.id);
  const h2 = attempts.supersede(root, { orderId: h.order.id, origin: 'human' });
  assert.ok(h2.order, h2.refused);
  reject(root, h2.order.id);
  assert.match(attempts.supersede(root, { orderId: h2.order.id, origin: 'human' }).refused, /used its 3 orders/,
    'the goal budget still binds a human');
});

test('a settled goal takes no new attempts', () => {
  const { root, project } = setup();
  const { goal, made: [a] } = goalWith(root, project);
  reject(root, a.id);
  goals.markFailed(root, goal.id, 'given up');
  const r = attempts.supersede(root, { orderId: a.id, origin: 'human' });
  assert.match(r.refused, /the goal is failed/);
});

test('what is never retried', () => {
  const { root, project } = setup();
  const { made: [q, v, w] } = goalWith(root, project, 3);
  assert.match(attempts.supersede(root, { orderId: q.id, origin: 'human' }).refused, /still queued/);
  orders.markRunning(root, v.id, { cwd: '/w', agent: 'f' });
  orders.markFinished(root, v.id, { exitCode: 0 });
  orders.recordVerdict(root, v.id, { verdictState: 'judged', verdict: 'verified', verdictReason: 'ok' });
  assert.match(attempts.supersede(root, { orderId: v.id, origin: 'human' }).refused, /verified/);
  orders.markRunning(root, w.id, { cwd: '/w', agent: 'f' });
  orders.markFinished(root, w.id, { exitCode: 0 });
  assert.match(attempts.supersede(root, { orderId: w.id, origin: 'human' }).refused, /awaiting its verdict/);
  assert.match(attempts.supersede(root, { orderId: w.id, origin: 'verdict' }).refused, /only a rejected verdict/);
  assert.strictEqual(attempts.supersede(root, { orderId: 'ord-nope', origin: 'human' }).kind, 'missing');
  assert.throws(() => attempts.supersede(root, { orderId: w.id, origin: 'robot' }), /origin must be/);
});

test('a cancelled order is retried verbatim, with no feedback invented', () => {
  const { root, project } = setup();
  const { made: [a] } = goalWith(root, project);
  orders.markCancelled(root, a.id);
  const r = attempts.supersede(root, { orderId: a.id, origin: 'human' });
  assert.strictEqual(r.order.prompt, 'do part 0');
});

test('a retry prompt over the limit is refused, never truncated', () => {
  const { root, project } = setup();
  const { made: [a] } = goalWith(root, project);
  reject(root, a.id, 'r'.repeat(19000));
  // Force the original near the limit through the store: create() would
  // refuse a prompt this long only past MAX_PROMPT.
  const raw = orders.get(root, a.id);
  require('../lib/store').writeJson(root, `orders/${a.id}.json`, { ...raw, prompt: 'p'.repeat(orders.MAX_PROMPT - 100) });
  const r = attempts.supersede(root, { orderId: a.id, origin: 'verdict' });
  assert.strictEqual(r.kind, 'final');
  assert.match(r.refused, /over the limit/);
});

test('attemptCap fails closed on a hand-edited budget', () => {
  const cap = (budget) => attempts.attemptCap({ budget });
  assert.strictEqual(attempts.attemptCap({}), 3, 'no budget at all: the default');
  assert.strictEqual(cap({}), 3, 'a pre-2d project has no key: the default, not unlimited');
  assert.strictEqual(cap({ maxAttemptsPerOrder: 5 }), 5);
  assert.strictEqual(cap({ maxAttemptsPerOrder: 1e9 }), 10);
  for (const bad of [0, -1, '2', NaN, 2.5]) {
    assert.strictEqual(cap({ maxAttemptsPerOrder: bad }), 1, `${String(bad)} read as more than one attempt`);
  }
  assert.strictEqual(cap(7), 1, 'a number where the budget object belongs');
});

test('a rollback orphan does not read as a successor', () => {
  // A retry whose goal could not take it is cancelled but keeps its goalId and
  // its supersedes. Only the goal's orderIds decide the family.
  const { root, project } = setup();
  const { goal, made: [a] } = goalWith(root, project);
  reject(root, a.id);
  const orphan = orders.create(root, { projectId: project.id, prompt: 'x', supersedes: a.id });
  orders.attachToGoal(root, orphan.id, goal.id, 0);
  orders.markCancelled(root, orphan.id);
  const r = attempts.supersede(root, { orderId: a.id, origin: 'verdict' });
  assert.ok(r.order, `refused: ${r.refused}`);
  // A fresh read: `a` above predates attachToGoal, so its goalId is null.
  assert.strictEqual(attempts.chainFor(root, orders.get(root, a.id)).supersededBy, r.order.id);
});
