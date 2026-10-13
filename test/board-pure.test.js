'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const pure = require('../public/pure');
const libOrders = require('../lib/orders');
const libGoals = require('../lib/goals');

const order = (over) => ({
  id: 'ord-1', projectId: 'p1', goalId: null, seq: null, title: '', prompt: 'do it',
  acceptance: '', agent: null, cwd: null, status: 'queued', exitCode: null, verdict: null,
  error: null, supersedes: null, createdAt: '2026-10-12T10:00:00.000Z', startedAt: null,
  finishedAt: null, ...over,
});

// ---------- mirrors of lib/ constants ----------
test('the settled sets are the ones lib/ enforces', () => {
  // Copied, not imported: pure.js runs in the browser. This is the drift pin.
  assert.deepStrictEqual(new Set(pure.ORDER_SETTLED_STATES), libOrders.SETTLED);
  assert.deepStrictEqual(new Set(pure.GOAL_SETTLED_STATES), libGoals.SETTLED);
});

// ---------- boardQuery ----------
test('boardQuery never builds the empty project= that lists the whole store', () => {
  for (const bad of ['', '   ', null, undefined, 5]) assert.strictEqual(pure.boardQuery(bad), null, String(bad));
  assert.strictEqual(pure.boardQuery('proj-1'), '/api/orders?project=proj-1');
  assert.strictEqual(pure.boardQuery('a b'), '/api/orders?project=a%20b');
});

// ---------- seq ----------
test('seqLabel counts from one and pads, and marks one-off orders', () => {
  assert.strictEqual(pure.seqLabel(order({ seq: 0 })), '01');
  assert.strictEqual(pure.seqLabel(order({ seq: 11 })), '12');
  assert.strictEqual(pure.seqLabel(order({ seq: null })), '··');
  assert.strictEqual(pure.seqLabel(order({ seq: -1 })), '··');
  assert.strictEqual(pure.seqLabel(order({ seq: 1.5 })), '··');
  assert.strictEqual(pure.seqSpoken(order({ seq: 2 })), '第 3 单');
  assert.strictEqual(pure.seqSpoken(order({ seq: null })), '一次性订单');
});

// ---------- title ----------
test('orderTitle falls back to the first prompt line, bounded', () => {
  assert.strictEqual(pure.orderTitle(order({ title: 'Fix login' })), 'Fix login');
  assert.strictEqual(pure.orderTitle(order({ title: '  ', prompt: 'first\nsecond' })), 'first');
  assert.strictEqual(pure.orderTitle(order({ title: '', prompt: '' })), '（无标题）');
  const long = pure.orderTitle(order({ prompt: '字'.repeat(200) }));
  assert.strictEqual(Array.from(long).length, 80);
  assert.ok(long.endsWith('…'));
});

// ---------- durations ----------
test('fmtDuration reads like a stopwatch', () => {
  assert.strictEqual(pure.fmtDuration(0), '0s');
  assert.strictEqual(pure.fmtDuration(4999), '4s');
  assert.strictEqual(pure.fmtDuration(125000), '2m 05s');
  assert.strictEqual(pure.fmtDuration(3780000), '1h 03m');
  assert.strictEqual(pure.fmtDuration(-1), '—');
  assert.strictEqual(pure.fmtDuration(NaN), '—');
});

test('orderElapsed is null for an order that never ran, and live for a running one', () => {
  const now = Date.parse('2026-10-12T10:05:00.000Z');
  assert.strictEqual(pure.orderElapsed(order(), now), null);
  assert.strictEqual(pure.orderElapsed(order({ status: 'failed', startedAt: null }), now), null);
  assert.strictEqual(pure.orderElapsed(order({ status: 'running', startedAt: '2026-10-12T10:04:00.000Z' }), now), 60000);
  assert.strictEqual(pure.orderElapsed(order({
    status: 'succeeded', startedAt: '2026-10-12T10:00:00.000Z', finishedAt: '2026-10-12T10:00:30.000Z',
  }), now), 30000);
});

// ---------- status text ----------
test('a succeeded order is never called a success', () => {
  // Spec §3: succeeded means the process exited 0, nothing more. The word
  // "成功" on the board would be the exact collapse the spec forbids.
  assert.strictEqual(pure.orderStatusText('succeeded'), '退出 0');
  assert.doesNotMatch(pure.orderStatusText('succeeded'), /成功/);
});

test('an unknown status is shown, not dropped, and prototype keys are not statuses', () => {
  assert.strictEqual(pure.orderStatusText('weird'), '未知状态（weird）');
  assert.strictEqual(pure.orderStatusText(undefined), '未知状态（undefined）');
  assert.strictEqual(pure.orderStatusText('constructor'), '未知状态（constructor）');
});

// ---------- exit code ----------
test('exitCodeText never invents an exit code', () => {
  assert.strictEqual(pure.exitCodeText(order({ status: 'failed', exitCode: 3, startedAt: 'x' })), '3');
  assert.strictEqual(pure.exitCodeText(order({ status: 'succeeded', exitCode: 0, startedAt: 'x' })), '0');
  assert.strictEqual(pure.exitCodeText(order({ status: 'running', startedAt: 'x' })), '还在运行');
  assert.strictEqual(pure.exitCodeText(order({ status: 'queued' })), '还没运行');
  assert.strictEqual(pure.exitCodeText(order({ status: 'failed', error: 'timeout', startedAt: 'x' })), '无（超时被终止）');
  assert.strictEqual(pure.exitCodeText(order({ status: 'failed', error: 'worktree: dirty' })), '无（没有启动）');
});

// ---------- failureView ----------
test('a timeout and a non-zero exit are different failures', () => {
  // Spec §8a: "A killed-by-timeout order is failed with error: 'timeout',
  // distinct from an agent that exited non-zero on its own."
  const t = pure.failureView(order({ status: 'failed', error: 'timeout', startedAt: 'x' }), { orderTimeoutMs: 900000 });
  const e = pure.failureView(order({ status: 'failed', exitCode: 3, startedAt: 'x' }), null);
  assert.strictEqual(t.kind, 'timeout');
  assert.strictEqual(e.kind, 'exit');
  assert.match(t.detail, /15m/);
  assert.doesNotMatch(t.title + t.detail, /退出码 \d/, 'a timeout must not show an exit code');
  assert.match(e.title, /退出码 3/);
});

test('failureView classifies every failed and settled shape', () => {
  const cases = [
    [order({ status: 'failed', error: 'daily limit reached (100 orders)', startedAt: null }), 'never-started'],
    [order({ status: 'failed', error: 'log: EACCES', startedAt: 'x' }), 'error'],
    [order({ status: 'failed', exitCode: null, error: null, startedAt: 'x' }), 'signal'],
    [order({ status: 'interrupted', error: 'interrupted', startedAt: 'x' }), 'interrupted'],
    [order({ status: 'cancelled', startedAt: 'x' }), 'cancelled'],
    [order({ status: 'cancelled', startedAt: null }), 'cancelled'],
  ];
  for (const [o, kind] of cases) assert.strictEqual(pure.failureView(o, null).kind, kind, JSON.stringify(o.error));
  assert.match(pure.failureView(cases[0][0], null).detail, /daily limit/);
  for (const st of ['queued', 'running', 'succeeded']) assert.strictEqual(pure.failureView(order({ status: st }), null), null, st);
});

test('a cancelled order says whether it had started', () => {
  assert.match(pure.failureView(order({ status: 'cancelled', startedAt: 'x' }), null).detail, /SIGTERM/);
  assert.match(pure.failureView(order({ status: 'cancelled', startedAt: null }), null).detail, /还没开始/);
});

// ---------- grouping ----------
test('groupOrders puts each status in one group, in board order, and keeps unknowns', () => {
  const list = [
    order({ id: 'a', status: 'succeeded', finishedAt: '2026-10-12T10:01:00Z' }),
    order({ id: 'b', status: 'running', startedAt: '2026-10-12T10:00:00Z' }),
    order({ id: 'c', status: 'interrupted', finishedAt: '2026-10-12T10:02:00Z' }),
    order({ id: 'd', status: 'queued' }),
    order({ id: 'e', status: 'bogus' }),
    order({ id: 'f', status: 'cancelled', finishedAt: '2026-10-12T10:03:00Z' }),
  ];
  const groups = pure.groupOrders(list);
  assert.deepStrictEqual(groups.map((g) => g.key), ['running', 'queued', 'failed', 'succeeded', 'cancelled', 'unknown']);
  assert.deepStrictEqual(groups.find((g) => g.key === 'failed').orders.map((o) => o.id), ['c']);
  assert.strictEqual(groups.reduce((n, g) => n + g.orders.length, 0), list.length, 'nothing dropped');
});

test('queued orders list oldest first - the order the scheduler offers them', () => {
  const list = [
    order({ id: 'ord-2', createdAt: '2026-10-12T10:00:02Z' }),
    order({ id: 'ord-1', createdAt: '2026-10-12T10:00:01Z' }),
  ];
  assert.deepStrictEqual(pure.groupOrders(list)[0].orders.map((o) => o.id), ['ord-1', 'ord-2']);
});

test('groupOrders does not reorder the array it was handed', () => {
  const list = [order({ id: 'ord-2', createdAt: '2026-10-12T10:00:02Z' }), order({ id: 'ord-1', createdAt: '2026-10-12T10:00:01Z' })];
  pure.groupOrders(list);
  assert.deepStrictEqual(list.map((o) => o.id), ['ord-2', 'ord-1']);
});

test('the succeeded group heading does not claim the work was checked', () => {
  const g = pure.BOARD_GROUPS.find((x) => x.key === 'succeeded');
  assert.match(g.label, /尚无验收/);
});

// ---------- today ----------
test('ordersToday counts by LOCAL day, as lib/orders.countToday does', () => {
  const late = new Date(2026, 9, 12, 23, 59).toISOString();
  const early = new Date(2026, 9, 13, 0, 1).toISOString();
  const now = new Date(2026, 9, 13, 12, 0).getTime();
  assert.strictEqual(pure.ordersToday([order({ createdAt: late }), order({ createdAt: early })], now), 1);
  assert.strictEqual(pure.ordersToday(null, now), 0);
});

// ---------- board state ----------
test('boardState tells error, empty, filtered and list apart', () => {
  assert.strictEqual(pure.boardState(false, { error: 'boom' }, null).kind, 'error');
  assert.strictEqual(pure.boardState(false, { error: 'boom' }, null).message, 'boom');
  assert.strictEqual(pure.boardState(true, { error: 'boom', orders: [order()] }, null).kind, 'error');
  assert.strictEqual(pure.boardState(true, { orders: 'x' }, null).kind, 'error');
  assert.strictEqual(pure.boardState(false, null, null).kind, 'error');
  assert.strictEqual(pure.boardState(true, { orders: [] }, null).kind, 'empty');
  assert.strictEqual(pure.boardState(true, { orders: [order()] }, null).kind, 'list');
  assert.strictEqual(pure.boardState(true, { orders: [order()] }, new Set(['other'])).kind, 'filtered');
  assert.deepStrictEqual(pure.boardState(true, { orders: [order()] }, new Set(['ord-1'])).orders.map((o) => o.id), ['ord-1']);
  assert.deepStrictEqual(pure.boardState(false, { error: 'x', orders: [order()] }, null).orders, []);
});

test('goalOrderIds reads the authoritative list and survives a malformed one', () => {
  const goals = [{ id: 'g1', orderIds: ['a', 'b', 5] }, { id: 'g2', orderIds: 'nope' }];
  assert.deepStrictEqual([...pure.goalOrderIds(goals, 'g1')], ['a', 'b']);
  assert.deepStrictEqual([...pure.goalOrderIds(goals, 'g2')], []);
  assert.deepStrictEqual([...pure.goalOrderIds(goals, 'missing')], []);
  assert.deepStrictEqual([...pure.goalOrderIds(null, 'g1')], []);
});

test('boardSignature changes when a row would render differently, and only then', () => {
  const a = [order({ status: 'running' })];
  assert.strictEqual(pure.boardSignature(a), pure.boardSignature([order({ status: 'running' })]));
  assert.notStrictEqual(pure.boardSignature(a), pure.boardSignature([order({ status: 'failed' })]));
  assert.notStrictEqual(pure.boardSignature(a), pure.boardSignature([order({ status: 'running', agent: 'claude' })]));
});

test('boardSignature also moves on a verdict state or a claim (plan 2d, Task 0)', () => {
  const a = [order({ status: 'queued' })];
  assert.notStrictEqual(pure.boardSignature(a), pure.boardSignature([order({ status: 'queued', claimed: true })]));
  assert.notStrictEqual(pure.boardSignature([order({ status: 'succeeded' })]),
    pure.boardSignature([order({ status: 'succeeded', verdictState: 'judging' })]));
});

test('boardSortFor sorts a copy, never the list it was handed', () => {
  // groupOrders hands it a fresh bucket, so through groupOrders alone dropping
  // the copy is an equivalent mutant (it survived the Task 4 sweep). Pinned
  // here directly, because the next caller may hand it something it owns.
  const list = [order({ id: 'ord-2', createdAt: '2026-10-12T10:00:02Z' }), order({ id: 'ord-1', createdAt: '2026-10-12T10:00:01Z' })];
  const sorted = pure.boardSortFor('queued', list);
  assert.deepStrictEqual(sorted.map((o) => o.id), ['ord-1', 'ord-2']);
  assert.deepStrictEqual(list.map((o) => o.id), ['ord-2', 'ord-1']);
});
