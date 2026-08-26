'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const goals = require('../lib/goals');

const created = [];
function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-goals-'));
  created.push(d);
  return d;
}
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

test('create stores a goal and returns it planning', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'prj-1', text: 'make the tests green' });
  assert.ok(g.id.startsWith('goal-'));
  assert.strictEqual(g.status, 'planning');
  assert.strictEqual(g.projectId, 'prj-1');
  assert.strictEqual(g.text, 'make the tests green');
  assert.deepStrictEqual(g.orderIds, []);
  assert.strictEqual(g.pmAgent, null);
  assert.strictEqual(g.error, null);
  assert.strictEqual(g.rawPlan, null);
  assert.ok(!Number.isNaN(Date.parse(g.createdAt)));
});

test('create requires a projectId and a text', () => {
  const root = tmpRoot();
  assert.throws(() => goals.create(root, { text: 'x' }), /projectId is required/);
  assert.throws(() => goals.create(root, { projectId: 'p' }), /text is required/);
  assert.throws(() => goals.create(root, { projectId: 'p', text: '   ' }), /text is required/);
});

test('an over-long text is rejected, never truncated', () => {
  // Same reasoning as an order's prompt: a shortened goal is a DIFFERENT goal
  // that still looks plausible, and the PM would decompose it without anyone
  // noticing the human asked for something else.
  const root = tmpRoot();
  assert.throws(
    () => goals.create(root, { projectId: 'p', text: 'x'.repeat(100001) }),
    /text is too long/
  );
  assert.strictEqual(goals.create(root, { projectId: 'p', text: 'x'.repeat(100000) }).text.length, 100000);
});

test('a goal round-trips through the store', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  assert.deepStrictEqual(goals.get(root, g.id), g);
});

test('get returns null for an unknown id, never undefined', () => {
  assert.strictEqual(goals.get(tmpRoot(), 'goal-nope'), null);
});

test('list returns goals newest first, filterable by project', () => {
  const root = tmpRoot();
  const a = goals.create(root, { projectId: 'p1', text: '1' });
  const b = goals.create(root, { projectId: 'p2', text: '2' });
  assert.deepStrictEqual(goals.list(root).map((g) => g.id), [b.id, a.id]);
  assert.strictEqual(goals.list(root, { projectId: 'p1' }).length, 1);
});

test('planned records the orders and moves the goal to running', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  const done = goals.planned(root, g.id, {
    orderIds: ['ord-a', 'ord-b'],
    pmAgent: 'claude',
    rawPlan: '[{"title":"a"},{"title":"b"}]',
  });
  assert.strictEqual(done.status, 'running');
  assert.deepStrictEqual(done.orderIds, ['ord-a', 'ord-b']);
  assert.strictEqual(done.pmAgent, 'claude');
  assert.match(done.rawPlan, /title/);
});

test('failPlanning records the reason and keeps the raw output', () => {
  // A PM that cannot produce orders is a prompt problem the human needs to
  // see, so the unparseable output is retained rather than discarded.
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  const done = goals.failPlanning(root, g.id, 'pm returned no JSON plan', 'I think we should...');
  assert.strictEqual(done.status, 'failed');
  assert.match(done.error, /no JSON plan/);
  assert.strictEqual(done.rawPlan, 'I think we should...');
  assert.deepStrictEqual(done.orderIds, []);
});

test('a settled goal is never rewritten', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  goals.failPlanning(root, g.id, 'first reason', 'raw');
  const again = goals.planned(root, g.id, { orderIds: ['ord-a'], pmAgent: 'claude', rawPlan: '[]' });
  assert.strictEqual(again.status, 'failed', 'a settled goal must stay settled');
  assert.strictEqual(again.error, 'first reason');
});

test('withinBudget accepts a plan at the cap and rejects one over it', () => {
  // Spec 8a: a plan over the cap fails the goal WHOLE, never truncated -
  // running the first 12 of a 30-order plan produces a half-executed goal
  // that looks complete, which is worse than refusing.
  assert.strictEqual(goals.withinBudget(12, { maxOrdersPerGoal: 12 }), true);
  assert.strictEqual(goals.withinBudget(13, { maxOrdersPerGoal: 12 }), false);
  assert.strictEqual(goals.withinBudget(1, {}), true, 'an absent cap must not refuse everything');
  assert.strictEqual(goals.withinBudget(0, { maxOrdersPerGoal: 12 }), false, 'an empty plan is not a plan');
  // A numeric cap is honoured literally. Reading a mis-typed 0 as "unlimited"
  // would switch the ceiling off silently, which is the failure this function
  // exists to prevent; only an absent or non-numeric cap means unlimited.
  assert.strictEqual(goals.withinBudget(1, { maxOrdersPerGoal: 0 }), false, 'a cap of 0 refuses, it does not mean unlimited');
});

test('reconcile marks orphaned planning goals interrupted', () => {
  // A goal still `planning` on boot lost the PM agent that was decomposing it.
  const root = tmpRoot();
  const a = goals.create(root, { projectId: 'p', text: 'x' });
  const b = goals.create(root, { projectId: 'p', text: 'y' });
  goals.failPlanning(root, b.id, 'done already', 'raw');

  assert.strictEqual(goals.reconcile(root), 1);
  assert.strictEqual(goals.get(root, a.id).status, 'failed');
  assert.match(goals.get(root, a.id).error, /interrupted/);
  assert.strictEqual(goals.get(root, b.id).error, 'done already', 'settled goals are untouched');
});

test('reconcile leaves a goal whose orders are already dispatched alone', () => {
  // Only `planning` is orphaned by a restart. `running` means the orders exist
  // and lib/orders reconciles them one at a time; sweeping the goal as well
  // would stamp a goal whose work is underway "interrupted while planning" on
  // every boot, and it is settled after that so nothing can correct it.
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  goals.planned(root, g.id, { orderIds: ['ord-a'], pmAgent: 'claude', rawPlan: '[]' });

  assert.strictEqual(goals.reconcile(root), 0);
  assert.strictEqual(goals.get(root, g.id).status, 'running');
  assert.strictEqual(goals.get(root, g.id).error, null);
});
