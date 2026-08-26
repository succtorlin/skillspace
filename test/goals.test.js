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
  assert.strictEqual(g.finishedAt, null);
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
  const mine = ['ord-a', 'ord-b'];
  const done = goals.planned(root, g.id, {
    orderIds: mine,
    pmAgent: 'claude',
    rawPlan: '[{"title":"a"},{"title":"b"}]',
  });
  assert.strictEqual(done.status, 'running');
  assert.deepStrictEqual(done.orderIds, ['ord-a', 'ord-b']);
  assert.strictEqual(done.pmAgent, 'claude');
  assert.match(done.rawPlan, /title/);

  // The record is a copy, not the caller's array: `orderIds` is what the goal
  // is judged complete against, so a caller that keeps appending would grow a
  // plan that was already handed over, without ever calling back in.
  //
  // The RETURNED record is the half that can actually alias. Asserting only
  // against the store proves nothing: writeJson serialises at write time, so
  // disk is immune whether the slice is there or not - and a version without it
  // passed exactly that assertion.
  mine.push('ord-c');
  assert.deepStrictEqual(done.orderIds, ['ord-a', 'ord-b'], 'the returned record must not follow the caller');
  assert.deepStrictEqual(goals.get(root, g.id).orderIds, ['ord-a', 'ord-b']);
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
  // Without this a settled goal reads "failed - still running" on any list that
  // shows a finish time.
  assert.ok(!Number.isNaN(Date.parse(done.finishedAt)), 'a settled goal must carry a finish time');
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
  assert.strictEqual(goals.withinBudget(1, { maxOrdersPerGoal: '12' }), false, 'a cap that is not a number is a mis-typed cap, not an absent one');
  // The parameter is named `budget` and the caller is holding a number, so
  // passing the cap itself is the natural slip. Any object accessor on a Number
  // yields undefined, so this used to read as "no cap" and pass any plan size -
  // the one answer this function must never give by accident.
  assert.strictEqual(goals.withinBudget(9999, 12), false, 'a bare number is not a budget');
  assert.strictEqual(goals.withinBudget(1, 'unlimited'), false);
  assert.strictEqual(goals.withinBudget(1, [12]), false);
  assert.strictEqual(goals.withinBudget(1, undefined), true, 'no budget at all is the documented unlimited case');
});

test('reconcile fails orphaned planning goals', () => {
  // A goal still `planning` on boot lost the PM agent that was decomposing it.
  const root = tmpRoot();
  const a = goals.create(root, { projectId: 'p', text: 'x' });
  const b = goals.create(root, { projectId: 'p', text: 'y' });
  goals.failPlanning(root, b.id, 'done already', 'raw');

  assert.strictEqual(goals.reconcile(root), 1);
  assert.strictEqual(goals.get(root, a.id).status, 'failed');
  assert.match(goals.get(root, a.id).error, /interrupted/);
  assert.ok(!Number.isNaN(Date.parse(goals.get(root, a.id).finishedAt)));
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

test('a nullish planning failure still records a diagnosis, never "undefined"', () => {
  // failPlanning is reached from `catch (e) { failPlanning(root, id, e.message, raw) }`,
  // and e.message is undefined for a thrown string or a non-Error rejection.
  // 'failed' is SETTLED, so whatever lands here is the record's last word.
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  const done = goals.failPlanning(root, g.id, undefined, 'raw');
  assert.strictEqual(done.status, 'failed');
  assert.notStrictEqual(done.error, 'undefined', 'a diagnosis named "undefined" diagnoses nothing');
  assert.match(done.error, /planning failure/);

  const h = goals.create(root, { projectId: 'p', text: 'y' });
  assert.match(goals.failPlanning(root, h.id, null, 'raw').error, /planning failure/);
});

test('planned refuses an empty plan rather than creating an unreachable goal', () => {
  // `running` with no orders is a zombie: reconcile() skips `running`, nothing
  // moves it on, and it is not SETTLED - so it sits in list() forever as work
  // in progress that does not exist. A caller with no orders wants failPlanning.
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  assert.throws(() => goals.planned(root, g.id, {}), /a plan with no orders is not a plan/);
  assert.throws(() => goals.planned(root, g.id, { orderIds: [] }), /a plan with no orders is not a plan/);
  assert.strictEqual(goals.get(root, g.id).status, 'planning', 'a refused plan must not move the goal');
});

test('planned normalises a missing agent and a non-string plan to null', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  const done = goals.planned(root, g.id, { orderIds: ['ord-a'] });
  assert.strictEqual(done.pmAgent, null);
  assert.strictEqual(done.rawPlan, null, 'rawPlan is read as the PM\'s text; an object there is not text');

  const h = goals.create(root, { projectId: 'p', text: 'y' });
  const two = goals.planned(root, h.id, { orderIds: ['ord-a'], pmAgent: '', rawPlan: { not: 'a string' } });
  assert.strictEqual(two.pmAgent, null);
  assert.strictEqual(two.rawPlan, null);
});

test('a goal is stored trimmed', () => {
  // projectId is a lookup key: stored with stray whitespace it would never
  // match the filter a board queries with, and the goal would be invisible.
  const root = tmpRoot();
  const g = goals.create(root, { projectId: '  prj-1  ', text: '  make the tests green  ' });
  assert.strictEqual(g.projectId, 'prj-1');
  assert.strictEqual(g.text, 'make the tests green');
  assert.strictEqual(goals.list(root, { projectId: 'prj-1' }).length, 1);
});

test('ids from one process are monotonically increasing', () => {
  // list()'s tiebreak falls back to id order, which only means anything if ids
  // rise with creation. Pinning that through list() alone is a coin flip: with
  // random ids a two-goal ordering test passes about half the time, so a
  // regression reads as an intermittent red most runs call green.
  const ids = [];
  for (let i = 0; i < 500; i++) ids.push(goals.newId());
  const sorted = [...ids].sort();
  assert.deepStrictEqual(ids, sorted, 'ids must sort in creation order');
  assert.strictEqual(new Set(ids).size, 500, 'ids must be unique');
});

test('a malformed record cannot crash list or reconcile', () => {
  // store.js quarantines UNPARSEABLE records so one bad file cannot stop the
  // app booting. A record that parses with the wrong shape defeats that one
  // layer up: it reaches the sort, throws TypeError, and every read of the
  // collection fails permanently until a human deletes the file by hand -
  // including reconcile(), which is the boot path that sweeps orphans.
  const root = tmpRoot();
  const store = require('../lib/store');
  const good = goals.create(root, { projectId: 'p', text: 'x' });
  // All sort BEFORE the real id, which is the position that throws.
  store.writeJson(root, 'goals/goal-000000AAAA.json', { id: 'goal-000000AAAA', createdAt: 12345 });
  store.writeJson(root, 'goals/goal-000000BBBB.json', 'not even an object');
  store.writeJson(root, 'goals/goal-000000CCCC.json', ['an', 'array']);
  store.writeJson(root, 'goals/goal-000000DDDD.json', { createdAt: new Date().toISOString() });
  store.writeJson(root, 'goals/goal-000000EEEE.json', null);

  const all = goals.list(root);
  assert.strictEqual(all.length, 1, 'malformed records must be skipped, not thrown on');
  assert.strictEqual(all[0].id, good.id);
  assert.strictEqual(goals.reconcile(root), 1, 'boot must still sweep the real orphan');
  assert.strictEqual(goals.get(root, good.id).status, 'failed');
});

test('list orders by createdAt first, and by id only to break a tie', () => {
  // Both halves have to be planted. Two goals created back to back may or may
  // not share a millisecond: when they share one the createdAt comparison is 0
  // and the id decides, when they do not the id never runs at all. So a test
  // that just creates two goals exercises whichever half the clock happened to
  // pick that run - measured, reversing the sort survived 5/5 runs and dropping
  // the id tiebreak survived 1/5, each hidden by the other half doing the work.
  const store = require('../lib/store');
  const older = '2026-01-01T00:00:00.000Z';
  const newer = '2026-01-02T00:00:00.000Z';
  const plant = (root, id, createdAt) => store.writeJson(root, `goals/${id}.json`,
    { id, projectId: 'p', text: 'x', status: 'planning', createdAt });

  const byTime = tmpRoot();
  // Ids run OPPOSITE to the timestamps, so sorting by id alone comes out wrong.
  plant(byTime, 'goal-aaa', newer);
  plant(byTime, 'goal-bbb', older);
  assert.deepStrictEqual(goals.list(byTime).map((g) => g.id), ['goal-aaa', 'goal-bbb'], 'newest createdAt first');

  const byTie = tmpRoot();
  // One millisecond, two goals. The id embeds newId()'s monotonic tick and is
  // the only record of order inside a millisecond; without the tiebreak this
  // falls through to store.list()'s ascending directory order, i.e. backwards.
  plant(byTie, 'goal-00000000000001-a', older);
  plant(byTie, 'goal-00000000000002-b', older);
  assert.deepStrictEqual(goals.list(byTie).map((g) => g.id),
    ['goal-00000000000002-b', 'goal-00000000000001-a'], 'a tie falls to the id, newest first');
});
