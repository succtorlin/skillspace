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

// ---------- scheduler ----------
const sched = (over) => ({ scheduler: {
  ticks: 10, offered: 0, started: 0, refused: 0, failedToStart: 0, errors: 0, skipped: 0,
  inFlight: 0, lastSkip: null, running: true, intervalMs: 1000, startedAt: '2026-10-12T10:00:00Z',
  lastTickAt: '2026-10-12T10:00:10Z', lastError: null, lastErrorAt: null, pausedProjects: 0, ...over,
} });
const T = Date.parse('2026-10-12T10:00:11Z');

test('schedulerView: off, unknown, idle, working', () => {
  assert.strictEqual(pure.schedulerView(null, null, T).kind, 'unknown');
  assert.strictEqual(pure.schedulerView(null, sched({ running: false }), T).kind, 'off');
  assert.strictEqual(pure.schedulerView(null, sched(), T).kind, 'idle');
  const w = pure.schedulerView(null, sched({ inFlight: 2 }), T);
  assert.strictEqual(w.kind, 'working');
  assert.match(w.detail, /手动派发/, 'inFlight counts only the loop\'s own dispatches, and says so');
});

test('schedulerView: `running` with no recent tick is stalled, not green', () => {
  // routes/scheduler.js: running means the timer is armed, not that the loop
  // is making progress.
  assert.strictEqual(pure.schedulerView(null, sched({ lastTickAt: '2026-10-12T09:59:00Z' }), T).kind, 'stalled');
  assert.strictEqual(pure.schedulerView(null, sched({ lastTickAt: null }), T).kind, 'stalled');
});

test('schedulerView: an old lastError is history, a rising count is now', () => {
  // lastError is never cleared; only lastErrorAt says whether it is current.
  const old = sched({ errors: 1, lastError: 'ENOENT', lastErrorAt: '2026-10-12T09:00:00Z' });
  const v = pure.schedulerView(sched({ errors: 1 }), old, T);
  assert.strictEqual(v.kind, 'idle');
  assert.strictEqual(v.lastError.message, 'ENOENT');
  assert.match(v.lastError.ago, /前$/);
  assert.strictEqual(pure.schedulerView(sched({ errors: 1 }), sched({ errors: 2, lastError: 'x', lastErrorAt: '2026-10-12T09:00:00Z' }), T).kind, 'erroring');
  assert.strictEqual(pure.schedulerView(null, sched({ errors: 1, lastError: 'x', lastErrorAt: '2026-10-12T10:00:10Z' }), T).kind, 'erroring');
});

test('schedulerView: paused projects and a fresh skip are surfaced', () => {
  assert.strictEqual(pure.schedulerView(null, sched({ pausedProjects: 1 }), T).kind, 'paused');
  // Since Task 0 the route names WHICH project: the board's own is said so,
  // another project's pause is not blamed on this one.
  const until = '2026-10-12T10:01:00Z';
  const mine = pure.schedulerView(null, sched({ pausedProjects: 1, pausedProjectIds: [{ id: 'p1', until, consecutive: 3 }] }), T, 'p1');
  assert.strictEqual(mine.kind, 'paused');
  assert.match(mine.text, /这个项目/);
  assert.match(mine.detail, /3 单/);
  const theirs = pure.schedulerView(null, sched({ pausedProjects: 1, pausedProjectIds: [{ id: 'p2', until, consecutive: 3 }] }), T, 'p1');
  assert.strictEqual(theirs.kind, 'idle', 'another project\'s pause turned this board red');
  assert.match(theirs.detail, /别的项目/);
  const b = pure.schedulerView(null, sched({ lastSkip: { reason: 'goal still being planned', orderId: 'o', at: '2026-10-12T10:00:10Z' } }), T);
  assert.strictEqual(b.kind, 'blocked');
  assert.match(b.detail, /goal still being planned/);
  assert.strictEqual(pure.schedulerView(null, sched({ lastSkip: { reason: 'x', orderId: 'o', at: '2026-10-12T09:00:00Z' } }), T).kind, 'idle');
  // A hold is a choice, not a fault: never the danger hairline.
  const held = pure.schedulerView(null, sched({ lastSkip: { reason: 'goal held for review', orderId: 'o', at: '2026-10-12T10:00:10Z' } }), T);
  assert.strictEqual(held.kind, 'held');
  assert.match(held.text, /等你放行/);
});

test('schedulerView says when nothing is judging results (plan 2d)', () => {
  assert.match(pure.schedulerView(null, sched({ judging: false }), T).detail || '', /验收没有开启/);
  assert.strictEqual(pure.schedulerView(null, sched({ judging: true }), T).detail, null);
});

// ---------- review mode ----------
test('reviewMode never promises a review window the backend does not give', () => {
  // Since Task 0 the backend HAS a window - a goal posted with hold:true -
  // so the auto note points at it instead of at restarting the server.
  const auto = pure.reviewMode(sched(), false);
  assert.strictEqual(auto.kind, 'auto');
  assert.match(auto.note, /自动运行/);
  assert.match(auto.note, /先审后跑/);
  assert.doesNotMatch(auto.note, /SKILLSPACE_SCHEDULER=0/);
  const manual = pure.reviewMode(sched({ running: false }), false);
  assert.strictEqual(manual.kind, 'manual');
  assert.match(manual.note, /派发/);
  // Fail closed: unknown is not "manual".
  assert.strictEqual(pure.reviewMode(null, false).kind, 'unknown');
  assert.match(pure.reviewMode(null, false).note, /无法确定/);
});

test('reviewMode with the hold on promises a stop, and only what release does', () => {
  for (const cur of [sched(), sched({ running: false }), null]) {
    const h = pure.reviewMode(cur, true);
    assert.strictEqual(h.kind, 'held');
    assert.match(h.note, /开始运行/);
    assert.match(h.submitLabel, /先审后跑/);
  }
  // With the loop off, release changes nothing by itself; the note says so.
  assert.match(pure.reviewMode(sched({ running: false }), true).note, /调度器关闭/);
});

// ---------- budgets ----------
test('budgetView states the structural limits and never mentions money as covered', () => {
  const p = { kind: 'git', concurrency: 2, budget: { maxOrdersPerGoal: 12, orderTimeoutMs: 900000, maxOrdersPerDay: 100 } };
  const v = pure.budgetView(p, [], Date.now());
  assert.match(v.concurrency.value, /2/);
  assert.deepStrictEqual(v.rows.map((r) => r.key), ['perGoal', 'attempts', 'timeout', 'daily']);
  assert.match(v.rows[2].value, /15m/);
  assert.match(v.rows[3].note, /按创建计数/);
  assert.match(v.rows[0].note, /重试也算/, 'plan 2d: retries count against the goal cap');
  assert.match(v.caveat, /不是花费/);
  assert.doesNotMatch(JSON.stringify(v), /[$¥]|美元|人民币|费用上限/);
});

test('budgetView explains why a directory runs one order at a time', () => {
  const v = pure.budgetView({ kind: 'dir', concurrency: 1, budget: {} }, [], Date.now());
  assert.match(v.concurrency.value, /1 单/);
  assert.match(v.concurrency.note, /无法隔离/);
});

test('budgetView flags a reached daily cap, and what it does', () => {
  const now = Date.now();
  const p = { kind: 'git', concurrency: 2, budget: { maxOrdersPerDay: 1 } };
  const v = pure.budgetView(p, [{ id: 'a', createdAt: new Date(now).toISOString() }], now);
  const daily = v.rows.find((r) => r.key === 'daily');
  assert.strictEqual(daily.over, true);
  assert.match(daily.note, /明天/);
});

test('budgetView treats a missing cap as unlimited, and says so', () => {
  const v = pure.budgetView({ kind: 'git', concurrency: 2, budget: {} }, [], Date.now());
  assert.match(v.rows.find((r) => r.key === 'perGoal').value, /未设上限/);
});

// ---------- transitions ----------
test('orderTransitions reports changes and arrivals, not unchanged rows', () => {
  const prev = [order({ id: 'a', status: 'running' }), order({ id: 'b', status: 'queued' })];
  const next = [order({ id: 'a', status: 'failed', error: 'timeout', startedAt: 'x' }), order({ id: 'b', status: 'queued' }), order({ id: 'c' })];
  const t = pure.orderTransitions(prev, next);
  assert.deepStrictEqual(t.map((x) => [x.id, x.from, x.to]), [['a', 'running', 'failed'], ['c', null, 'queued']]);
  const msg = pure.announcement(t);
  assert.match(msg, /新增 1 单/);
  assert.match(msg, /超时/);
  assert.strictEqual(pure.announcement([]), '');
  assert.deepStrictEqual(pure.orderTransitions(null, next), []);
});

test('announcement stays one sentence when many rows move at once', () => {
  const prev = [1, 2, 3, 4, 5].map((i) => order({ id: 'o' + i, status: 'running' }));
  const next = prev.map((o) => ({ ...o, status: 'succeeded' }));
  assert.match(pure.announcement(pure.orderTransitions(prev, next)), /另有 2 单/);
});

// ---------- log ----------
test('logStep: stop only when the order is settled AND the log is drained', () => {
  const live = pure.logStep({ log: { text: 'a', next: 1, size: 1, exists: true }, status: 'running' }, true);
  assert.deepStrictEqual([live.ok, live.done, live.more], [true, false, false]);
  const behind = pure.logStep({ log: { text: 'a', next: 1, size: 5, exists: true }, status: 'succeeded' }, false);
  assert.deepStrictEqual([behind.done, behind.more], [false, true]);
  const done = pure.logStep({ log: { text: '', next: 5, size: 5, exists: true }, status: 'succeeded' }, false);
  assert.strictEqual(done.done, true);
  assert.strictEqual(pure.logStep({ log: { next: -1 } }, true).ok, false);
  assert.strictEqual(pure.logStep(null, true).ok, false);
  assert.strictEqual(pure.logStep({ log: { text: '', next: 0, size: 0, reset: true } }, true).reset, true);
});

test('appendCapped keeps the tail and never starts on half a surrogate pair', () => {
  assert.deepStrictEqual(pure.appendCapped('ab', 'cd', 10), { text: 'abcd', dropped: 0 });
  assert.deepStrictEqual(pure.appendCapped('abcdef', 'gh', 4), { text: 'efgh', dropped: 4 });
  const r = pure.appendCapped('a😀', 'b', 2);   // 'a', '\ud83d', '\ude00', 'b'
  assert.strictEqual(r.text, 'b');
  assert.strictEqual(r.dropped, 3);
});

test('shouldStick follows the tail only when the reader is already there', () => {
  assert.strictEqual(pure.shouldStick(900, 100, 1000), true);
  assert.strictEqual(pure.shouldStick(880, 100, 1000), true);
  assert.strictEqual(pure.shouldStick(500, 100, 1000), false);
});

// ---------- action outcomes ----------
test('orderActionOutcome maps every route answer to honest copy', () => {
  const o = pure.orderActionOutcome;
  assert.strictEqual(o('dispatch', 200, { order: {} }).ok, true);
  assert.strictEqual(o('cancel', 200, { order: {} }).ok, true);
  const raced = o('dispatch', 409, { error: 'order is already being dispatched' });
  assert.strictEqual(raced.ok, true, 'losing the claim to the scheduler is not a failure: the order runs');
  assert.match(raced.text, /调度器/);
  assert.match(o('dispatch', 409, { error: 'order is already running', order: { status: 'running' } }).text, /运行中/);
  assert.match(o('cancel', 409, { error: 'order is already succeeded' }).text, /退出 0/);
  assert.match(o('dispatch', 409, { error: '该项目已有任务在运行（未隔离的目录一次只能跑一个）' }).text, /未隔离/);
  assert.match(o('dispatch', 429, { error: 'too many orders running (4)' }).text, /已满/);
  assert.match(o('dispatch', 404, {}).text, /不存在/);
  assert.match(o('dispatch', 0, null).text, /无法连接/);
  assert.match(o('dispatch', 400, { error: '未知的 agent：x' }).text, /未知的 agent/);
});

test('goalSubmitOutcome keeps the server reason and translates the English ones', () => {
  const g = pure.goalSubmitOutcome;
  assert.strictEqual(g(200, { goal: { id: 'g' } }).ok, true);
  assert.strictEqual(g(200, {}).ok, false, 'a 200 without a goal is not a success');
  assert.match(g(400, { error: 'text is required' }).text, /不能为空/);
  assert.match(g(400, { error: 'text is too long (100001 > 100000)' }).text, /太长/);
  assert.match(g(404, { error: 'no such project' }).text, /项目不存在/);
  assert.match(g(429, { error: 'too many agents running (4)' }).text, /已满/);
  assert.match(g(0, null).text, /无法连接/);
  assert.match(g(500, { error: 'EACCES' }).text, /EACCES/);
});

test('goalStatusText: done is verified now, and stalled asks for a human', () => {
  // Plan 2d changed what `done` means: every chain's latest attempt was
  // VERIFIED. The plan-3 text "不代表都成功" was true before 2d and is false now.
  assert.match(pure.goalStatusText('done'), /已验收/);
  assert.match(pure.goalStatusText('stalled'), /需要你/);
  assert.strictEqual(pure.goalStatusText('planning'), 'PM 拆解中');
  assert.match(pure.goalStatusText('nope'), /未知状态/);
  assert.match(pure.goalStatusText('planned', { held: true }), /等你放行/);
  assert.doesNotMatch(pure.goalStatusText('planned', { held: false }), /放行/);
});

test('oneOffNote says a directory project is edited in place', () => {
  assert.match(pure.oneOffNote({ name: 'x', kind: 'dir' }), /直接改动/);
  assert.match(pure.oneOffNote({ name: 'x', kind: 'git' }), /worktree/);
  assert.match(pure.oneOffNote(null), /先在左侧选一个项目/);
  assert.match(pure.oneOffNote({ name: 'x', kind: 'git' }), /不经过 PM/);
});

// ---------- claimed (Task 0) ----------
test('orderRowStatus: a claimed queued order is starting, not waiting', () => {
  assert.deepStrictEqual(pure.orderRowStatus(order({ status: 'queued', claimed: true }), null), { text: '正在启动', dot: 'running' });
  assert.deepStrictEqual(pure.orderRowStatus(order({ status: 'queued' }), null), { text: '排队', dot: 'queued' });
  assert.deepStrictEqual(pure.orderRowStatus(order({ status: 'failed', error: 'timeout', startedAt: 'x' }), null), { text: '超时，被终止', dot: 'failed' });
  assert.deepStrictEqual(pure.orderRowStatus(order({ status: 'running', claimed: true }), null), { text: '运行中', dot: 'running' });
  assert.strictEqual(pure.orderRowStatus(order({ status: undefined }), null).dot, 'unknown');
});

test('schedulerView: a skip says whose order it was, and in the console\'s words', () => {
  const at = '2026-10-12T10:00:10Z';
  const s = (reason) => sched({ lastSkip: { reason, orderId: 'ord-mine', at } });
  const mine = pure.schedulerView(null, s('daily order cap reached'), T, 'p1', new Set(['ord-mine']));
  assert.strictEqual(mine.kind, 'blocked');
  assert.match(mine.detail, /今日订单数已到上限/);
  assert.match(mine.detail, /这个项目的订单/);
  const theirs = pure.schedulerView(null, s('daily order cap reached'), T, 'p1', new Set(['ord-other']));
  assert.strictEqual(theirs.kind, 'idle', 'another project\'s blocked order reddened this board');
  assert.match(theirs.detail, /别的项目的订单被挡住/);
  const busy = pure.schedulerView(null, sched({ inFlight: 2, lastSkip: { reason: 'daily order cap reached', orderId: 'x', at } }), T, 'p1', new Set());
  assert.strictEqual(busy.kind, 'working', 'another project\'s skip masked this board\'s work');
  // An unknown reason is shown raw rather than dropped.
  assert.match(pure.schedulerView(null, s('something new'), T).detail, /something new/);
  // A hold on ANOTHER project's goal does not turn this board into "waiting for you".
  const heldElsewhere = pure.schedulerView(null, s('goal held for review'), T, 'p1', new Set(['ord-x']));
  assert.strictEqual(heldElsewhere.kind, 'idle');
  assert.match(heldElsewhere.detail, /别的项目/);
  assert.strictEqual(pure.schedulerView(null, s('goal held for review'), T, 'p1', new Set(['ord-mine'])).kind, 'held');
});

// ---------- release (Task 0's hold) ----------
test('goalReleaseOutcome: released, already released, settled, gone, offline', () => {
  const r = pure.goalReleaseOutcome;
  assert.strictEqual(r(200, { goal: { id: 'g', held: false } }).ok, true);
  assert.strictEqual(r(200, {}).ok, false, 'a 200 without the goal is not a release');
  const twice = r(409, { error: 'goal is not held' });
  assert.strictEqual(twice.ok, true, 'someone else released it: the goal is running either way');
  assert.match(twice.text, /已经放行/);
  assert.match(r(409, { error: 'goal is already failed' }).text, /失败/);
  assert.match(r(404, { error: 'no such goal' }).text, /不存在/);
  assert.match(r(0, null).text, /无法连接/);
  assert.match(r(403, { error: 'x' }).text, /x/);
});

test('planDispatchable: a held goal\'s steps can be approved one by one', () => {
  const sOn = { scheduler: { running: true, intervalMs: 1000 } };
  const sOff = { scheduler: { running: false } };
  assert.strictEqual(pure.planDispatchable({ held: true }, sOn), true);
  assert.strictEqual(pure.planDispatchable({ held: false }, sOn), false, 'the loop will run it anyway');
  assert.strictEqual(pure.planDispatchable({ held: false }, sOff), true);
  assert.strictEqual(pure.planDispatchable({}, null), false, 'unknown fails closed: no second door');
});

// ---------- verdicts and attempt chains (plan 2d, as implemented) ----------
// Shapes are 2d's real ones: verdict beside status, verdictState saying where
// the judgement is, chains derived on the server and sent BESIDE the records.
const judged = (over) => order({ goalId: 'g1', status: 'succeeded', exitCode: 0, startedAt: 'x', finishedAt: 'y',
  verdict: null, verdictState: null, verdictReason: null, verdictError: null, verdictRaw: null, verdictRuns: 0, retryRefused: null, ...over });
const chain = (over) => ({ rootId: 'a', headId: 'a', ids: ['a'], attempt: 1, attempts: 1, supersedes: null, supersededBy: null, ...over });

test('verified, exit-0-awaiting and rejected are three different claims', () => {
  const v = pure.verdictView(judged({ verdict: 'verified', verdictState: 'judged', verdictReason: 'tests pass' }));
  const u = pure.verdictView(judged({}));
  const r = pure.verdictView(judged({ verdict: 'rejected', verdictState: 'judged', verdictReason: 'wrong file' }));
  assert.deepStrictEqual([v.kind, u.kind, r.kind], ['verified', 'awaiting', 'rejected']);
  assert.notStrictEqual(v.glyph, u.glyph);
  assert.doesNotMatch(u.label, /验收通过|已验收/, 'exit 0 must never read as verified');
  assert.strictEqual(r.detail, 'wrong file');
  assert.match(pure.verdictView(judged({ status: 'failed', exitCode: 3, verdict: 'rejected', verdictState: 'judged' })).detail, /没有记录/);
});

test('a record written before plan 2d reads as no verdict yet', () => {
  const old = order({ goalId: 'g1', status: 'succeeded', exitCode: 0, startedAt: 'x' });
  delete old.verdict;
  assert.strictEqual(pure.verdictView(old).kind, 'awaiting');
  assert.strictEqual(pure.verdictView(order({ status: 'running' })), null);
});

test('judging and an errored verdict are states of their own', () => {
  assert.strictEqual(pure.verdictView(judged({ verdictState: 'judging' })).kind, 'judging');
  const e = pure.verdictView(judged({ verdictState: 'error', verdictError: 'no verdict in the reply' }));
  assert.strictEqual(e.kind, 'error');
  assert.match(e.detail, /no verdict in the reply/);
});

test('an order no PM will judge says so, and an unknown verdict is shown', () => {
  const oneOff = pure.verdictView(order({ status: 'succeeded', exitCode: 0, startedAt: 'x' }));
  assert.strictEqual(oneOff.kind, 'none');
  assert.doesNotMatch(oneOff.label, /已验收/);
  assert.strictEqual(pure.verdictView(judged({ status: 'cancelled' })), null);
  assert.strictEqual(pure.verdictView(judged({ verdict: 'maybe', verdictState: 'judged' })).kind, 'unknown');
});

test('attempt info comes from the server chain, and null means unknown', () => {
  const c = chain({ rootId: 'a', headId: 'c', ids: ['a', 'b', 'c'], attempt: 2, attempts: 3, supersedes: 'a', supersededBy: 'c' });
  const i = pure.attemptInfo(c);
  assert.deepStrictEqual([i.attempt, i.of, i.latest], [2, 3, false]);
  assert.strictEqual(pure.attemptInfo(null), null);
  assert.strictEqual(pure.attemptInfo({ attempt: 'x' }), null, 'a malformed chain is not numbered');
  assert.match(pure.attemptLabel(i, order({ seq: 6 })), /第 2 次尝试 · 共 3 次 · 源自 ⌐07¬/);
  assert.match(pure.attemptLabel(i, null), /^第 2 次尝试 · 共 3 次$/);
});

test('latestOrders hides superseded attempts and keeps orders with no chain', () => {
  const list = [order({ id: 'a' }), order({ id: 'b' }), order({ id: 'z' }), order({ id: 'q' })];
  const chains = {
    a: chain({ headId: 'b', ids: ['a', 'b'], attempts: 2, supersededBy: 'b' }),
    b: chain({ headId: 'b', ids: ['a', 'b'], attempt: 2, attempts: 2, supersedes: 'a' }),
    z: chain({ rootId: 'z', headId: 'z', ids: ['z'] }),
    q: null,
  };
  assert.deepStrictEqual(pure.latestOrders(list, chains).map((o) => o.id), ['b', 'z', 'q']);
  assert.deepStrictEqual(pure.latestOrders(list, undefined).map((o) => o.id), ['a', 'b', 'z', 'q']);
});

test('retryOffer mirrors the server\'s refusals, and never forks a chain', () => {
  const head = chain({});
  const off = (o, c = head, g = { status: 'running' }) => pure.retryOffer(o, c, g);
  assert.strictEqual(off(judged({ verdict: 'rejected', verdictState: 'judged' })), true);
  assert.strictEqual(off(judged({ verdict: 'verified', verdictState: 'judged' })), false, 'verified: nothing to retry');
  assert.strictEqual(off(judged({})), false, 'awaiting its verdict: retrying would race the judge');
  // A FAILED result is judged too (spec §10): exit 3 awaiting its verdict is
  // not retryable yet. This case is what kills the mutant that drops the
  // awaiting check - a succeeded one is refused by the last line anyway.
  assert.strictEqual(off(judged({ status: 'failed', exitCode: 3 })), false, 'a failed result awaiting its verdict');
  assert.strictEqual(off(judged({ verdictState: 'judging' })), false);
  assert.strictEqual(off(judged({ verdictState: 'error' })), true, 'an errored verdict will never come; a human may retry past it');
  assert.strictEqual(off(judged({ status: 'cancelled' })), true);
  assert.strictEqual(off(judged({ status: 'interrupted' })), true);
  assert.strictEqual(off(judged({ status: 'failed', startedAt: null })), true, 'never started');
  assert.strictEqual(off(judged({ status: 'running' })), false);
  assert.strictEqual(off(judged({ verdict: 'rejected', verdictState: 'judged' }), chain({ supersededBy: 'b' })), false, 'superseded');
  assert.strictEqual(off(judged({ verdict: 'rejected', verdictState: 'judged' }), head, { status: 'failed' }), false, 'goal settled');
  assert.strictEqual(off(judged({ verdict: 'rejected', verdictState: 'judged' }), head, { status: 'planning' }), false);
  // A one-off order has no PM: a failure can be retried, a clean exit is not offered one.
  assert.strictEqual(pure.retryOffer(order({ status: 'failed', exitCode: 3, startedAt: 'x' }), head, null), true);
  assert.strictEqual(pure.retryOffer(order({ status: 'succeeded', exitCode: 0, startedAt: 'x' }), head, null), false);
});

test('verdictRetryOffer: an errored verdict, or one nothing will ever give', () => {
  const g = { status: 'stalled' };
  const on = { scheduler: { running: true, judging: true } };
  const off = { scheduler: { running: false, judging: true } };
  assert.strictEqual(pure.verdictRetryOffer(judged({ verdictState: 'error' }), g, on).label, '重新验收');
  assert.strictEqual(pure.verdictRetryOffer(judged({}), g, on), null, 'the loop will judge it');
  assert.strictEqual(pure.verdictRetryOffer(judged({}), g, off).label, '请 PM 验收');
  assert.strictEqual(pure.verdictRetryOffer(judged({}), g, { scheduler: { running: true, judging: false } }).label, '请 PM 验收');
  assert.strictEqual(pure.verdictRetryOffer(judged({ verdictState: 'judged', verdict: 'rejected' }), g, off), null);
  assert.strictEqual(pure.verdictRetryOffer(judged({ status: 'cancelled' }), g, off), null, 'no result to judge');
  assert.strictEqual(pure.verdictRetryOffer(order({ status: 'succeeded', startedAt: 'x' }), null, off), null, 'no PM for a one-off');
  assert.strictEqual(pure.verdictRetryOffer(judged({ verdictState: 'error' }), { status: 'done' }, off), null, 'goal settled');
});

test('retry outcomes keep the server reason and translate the known ones', () => {
  const r = pure.retryOutcome;
  assert.strictEqual(r('retry', 200, { order: { id: 'n' }, chain: null }).ok, true);
  assert.strictEqual(r('retry', 200, {}).ok, false);
  assert.match(r('retry', 409, { error: 'the order is awaiting its verdict' }).text, /还在等验收/);
  assert.match(r('retry', 409, { error: 'already superseded by ord-x', supersededBy: 'ord-x' }).text, /已经重试过/);
  assert.match(r('retry', 409, { error: 'no attempts left (3 of 3)' }).text, /尝试次数/);
  assert.match(r('retry', 409, { error: 'the goal has used its 12 orders' }).text, /12/);
  assert.match(r('retry', 429, { error: 'daily limit reached (100 orders)' }).text, /daily limit/);
  assert.match(r('verdict', 400, { error: '未知的 agent：x（可用：claude）' }).text, /未知的 agent/);
  assert.match(r('verdict', 429, { error: 'too many agents running (4)' }).text, /已满/);
  assert.match(r('verdict', 409, { error: "the order is not part of its goal's plan" }).text, /不在目标的计划里/);
  assert.match(r('retry', 0, null).text, /无法连接/);
});
