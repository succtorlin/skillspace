'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const orders = require('../lib/orders');

const created = [];
function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-orders-'));
  created.push(d);
  return d;
}
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

test('create stores an order and returns it queued', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'prj-1', prompt: 'do the thing' });
  assert.ok(o.id.startsWith('ord-'));
  assert.strictEqual(o.status, 'queued');
  assert.strictEqual(o.projectId, 'prj-1');
  assert.strictEqual(o.prompt, 'do the thing');
  assert.strictEqual(o.goalId, null, 'goalId is reserved for plan 2b');
  assert.strictEqual(o.exitCode, null);
  assert.strictEqual(o.verdict, null);
  assert.ok(!Number.isNaN(Date.parse(o.createdAt)));
});

test('create requires a projectId and a prompt', () => {
  const root = tmpRoot();
  assert.throws(() => orders.create(root, { prompt: 'x' }), /projectId is required/);
  assert.throws(() => orders.create(root, { projectId: 'p' }), /prompt is required/);
  assert.throws(() => orders.create(root, { projectId: 'p', prompt: '   ' }), /prompt is required/);
});

test('an order round-trips through the store', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'prj-1', prompt: 'p' });
  assert.deepStrictEqual(orders.get(root, o.id), o);
});

test('get returns null for an unknown id, never undefined', () => {
  assert.strictEqual(orders.get(tmpRoot(), 'ord-nope'), null);
});

test('list returns every order, newest first', () => {
  const root = tmpRoot();
  const a = orders.create(root, { projectId: 'p', prompt: '1' });
  const b = orders.create(root, { projectId: 'p', prompt: '2' });
  const all = orders.list(root);
  assert.strictEqual(all.length, 2);
  assert.deepStrictEqual(all.map((o) => o.id), [b.id, a.id]);
});

test('list filters by project', () => {
  const root = tmpRoot();
  orders.create(root, { projectId: 'p1', prompt: 'x' });
  orders.create(root, { projectId: 'p2', prompt: 'y' });
  assert.strictEqual(orders.list(root, { projectId: 'p1' }).length, 1);
});

test('the lifecycle advances queued -> running -> succeeded', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  const started = orders.markRunning(root, o.id, { cwd: '/tmp/wt', agent: 'claude' });
  assert.strictEqual(started.status, 'running');
  assert.strictEqual(started.cwd, '/tmp/wt');
  assert.strictEqual(started.agent, 'claude');
  assert.ok(!Number.isNaN(Date.parse(started.startedAt)));

  const done = orders.markFinished(root, o.id, { exitCode: 0 });
  assert.strictEqual(done.status, 'succeeded');
  assert.strictEqual(done.exitCode, 0);
  assert.ok(!Number.isNaN(Date.parse(done.finishedAt)));
});

test('a non-zero exit is failed, not succeeded', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  orders.markRunning(root, o.id, { cwd: '/tmp/wt', agent: 'claude' });
  const done = orders.markFinished(root, o.id, { exitCode: 3 });
  assert.strictEqual(done.status, 'failed');
  assert.strictEqual(done.exitCode, 3);
});

test('a timeout is failed with error "timeout", distinct from a non-zero exit', () => {
  // Spec: the two mean different things and must not be collapsed. A reader of
  // the board has to tell "the agent gave up" from "we stopped it".
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  orders.markRunning(root, o.id, { cwd: '/tmp/wt', agent: 'claude' });
  const done = orders.markFinished(root, o.id, { error: 'timeout' });
  assert.strictEqual(done.status, 'failed');
  assert.strictEqual(done.error, 'timeout');
  assert.strictEqual(done.exitCode, null, 'a killed process has no exit code of its own');
});

test('markFailed records a failure that happened before any agent started', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  const done = orders.markFailed(root, o.id, 'worktree: dirty tree');
  assert.strictEqual(done.status, 'failed');
  assert.match(done.error, /dirty tree/);
  assert.strictEqual(done.startedAt, null, 'nothing ever started');
});

test('cancel is its own status, not a failure', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  orders.markRunning(root, o.id, { cwd: '/tmp/wt', agent: 'claude' });
  assert.strictEqual(orders.markCancelled(root, o.id).status, 'cancelled');
});

test('a finished order cannot be moved again', () => {
  // Without this, a late close event from a process we already timed out would
  // rewrite the record and erase why it actually ended.
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  orders.markRunning(root, o.id, { cwd: '/tmp/wt', agent: 'claude' });
  orders.markFinished(root, o.id, { error: 'timeout' });
  const again = orders.markFinished(root, o.id, { exitCode: 0 });
  assert.strictEqual(again.status, 'failed', 'a settled order must stay settled');
  assert.strictEqual(again.error, 'timeout');
});

test('countToday counts only today and only this project', () => {
  const root = tmpRoot();
  const a = orders.create(root, { projectId: 'p1', prompt: 'x' });
  orders.create(root, { projectId: 'p2', prompt: 'y' });
  // Backdate one by writing the record directly, the way a previous day's run
  // would look on disk after a restart.
  const old = { ...orders.get(root, a.id), createdAt: '2020-01-01T00:00:00.000Z' };
  require('../lib/store').writeJson(root, `orders/${a.id}.json`, old);
  assert.strictEqual(orders.countToday(root, 'p1'), 0);
  assert.strictEqual(orders.countToday(root, 'p2'), 1);
});

test('reconcile marks orphaned running orders interrupted', () => {
  // On boot a running order's child process is gone. It is never assumed to
  // have succeeded.
  const root = tmpRoot();
  const a = orders.create(root, { projectId: 'p', prompt: 'x' });
  const b = orders.create(root, { projectId: 'p', prompt: 'y' });
  orders.markRunning(root, a.id, { cwd: '/tmp/wt', agent: 'claude' });
  orders.markFinished(root, b.id, { exitCode: 0 });

  const n = orders.reconcile(root);
  assert.strictEqual(n, 1, 'exactly one order was running');
  assert.strictEqual(orders.get(root, a.id).status, 'interrupted');
  assert.strictEqual(orders.get(root, a.id).error, 'interrupted');
  assert.strictEqual(orders.get(root, b.id).status, 'succeeded', 'settled orders are untouched');
});
