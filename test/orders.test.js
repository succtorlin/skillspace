'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const orders = require('../lib/orders');
const store = require('../lib/store');

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
  assert.throws(() => orders.create(root, { projectId: '   ', prompt: 'x' }), /projectId is required/);
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

test('a timeout discards the exit code of the process we killed', () => {
  // The realistic dispatcher shape: we SIGTERM a timed-out child, close fires
  // with 143, and we also know we timed it out. Without the guard the record
  // would show exitCode 143 and read as an ordinary non-zero exit, losing the
  // one fact that distinguishes "the agent gave up" from "we stopped it".
  // The error-only case cannot catch this: exitCode defaults to null there, so
  // the ternary is a no-op and the mutant survives.
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  orders.markRunning(root, o.id, { cwd: '/tmp/wt', agent: 'claude' });
  const done = orders.markFinished(root, o.id, { exitCode: 143, error: 'timeout' });
  assert.strictEqual(done.status, 'failed');
  assert.strictEqual(done.error, 'timeout');
  assert.strictEqual(done.exitCode, null, 'the killed process exit code must not survive');
});

test('markFailed records a failure that happened before any agent started', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  const done = orders.markFailed(root, o.id, 'worktree: dirty tree');
  assert.strictEqual(done.status, 'failed');
  assert.match(done.error, /dirty tree/);
  assert.strictEqual(done.startedAt, null, 'nothing ever started');

  // And it must NULL an existing startedAt, not merely decline to set one.
  // Leaving a stale timestamp would contradict the field's whole meaning:
  // the board reads a non-null startedAt as "this actually ran".
  const r = orders.create(root, { projectId: 'p', prompt: 'x' });
  orders.markRunning(root, r.id, { cwd: '/tmp/wt', agent: 'claude' });
  assert.strictEqual(orders.markFailed(root, r.id, 'boom').startedAt, null);
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

test('an over-long prompt is rejected, never silently truncated', () => {
  const root = tmpRoot();
  assert.throws(
    () => orders.create(root, { projectId: 'p', prompt: 'x'.repeat(100001) }),
    /prompt is too long/
  );
  // and the boundary is inclusive
  const ok = orders.create(root, { projectId: 'p', prompt: 'x'.repeat(100000) });
  assert.strictEqual(ok.prompt.length, 100000);
});

test('countToday uses the local day, not UTC', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  // An order created "now" always counts, whatever the host zone.
  assert.strictEqual(orders.countToday(root, 'p'), 1);
  // One dated to local midnight today still counts; one a day earlier does not.
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  require('../lib/store').writeJson(root, `orders/${o.id}.json`,
    { ...orders.get(root, o.id), createdAt: midnight.toISOString() });
  assert.strictEqual(orders.countToday(root, 'p'), 1, 'local midnight is today');

  const yesterday = new Date(midnight.getTime() - 1000);
  require('../lib/store').writeJson(root, `orders/${o.id}.json`,
    { ...orders.get(root, o.id), createdAt: yesterday.toISOString() });
  assert.strictEqual(orders.countToday(root, 'p'), 0, 'one second before local midnight is not');
});

test('every terminal state resists a late write, not just failed', () => {
  // The guard exists because a process we already gave up on can still fire a
  // close event. reconcile() settles by writing directly rather than through
  // patch(), so 'interrupted' is the state most likely to meet a late close -
  // and it was the least defended.
  const settle = {
    succeeded: (root, id) => { orders.markRunning(root, id, { cwd: '/tmp', agent: 'a' });
                               orders.markFinished(root, id, { exitCode: 0 }); },
    failed:    (root, id) => { orders.markRunning(root, id, { cwd: '/tmp', agent: 'a' });
                               orders.markFinished(root, id, { exitCode: 9 }); },
    cancelled: (root, id) => { orders.markRunning(root, id, { cwd: '/tmp', agent: 'a' });
                               orders.markCancelled(root, id); },
    interrupted: (root, id) => { orders.markRunning(root, id, { cwd: '/tmp', agent: 'a' });
                                 orders.reconcile(root); },
  };
  for (const [state, reach] of Object.entries(settle)) {
    // A root per iteration. Sharing one was correct only because 'interrupted'
    // happens to sort last and every earlier case settles before it runs -
    // neither of which the test asserted. One stray running peer and the shared
    // reconcile() would rewrite it underneath the assertion.
    const root = tmpRoot();
    const o = orders.create(root, { projectId: `p-${state}`, prompt: 'x' });
    reach(root, o.id);
    const before = orders.get(root, o.id);
    assert.strictEqual(before.status, state, `setup failed to reach ${state}`);

    // Every late mover must bounce off it.
    orders.markFinished(root, o.id, { exitCode: 0 });
    orders.markCancelled(root, o.id);
    orders.markRunning(root, o.id, { cwd: '/other', agent: 'b' });
    assert.deepStrictEqual(orders.get(root, o.id), before, `${state} was rewritten by a late call`);
  }
});

test('ids from one process are monotonically increasing', () => {
  // The sort tiebreak falls back to id order, which only means anything if ids
  // rise with creation. createdAt is millisecond-resolution and ~75% of rapid
  // pairs share a millisecond, so the id is what actually orders them.
  const ids = [];
  for (let i = 0; i < 500; i++) ids.push(orders.newId());
  const sorted = [...ids].sort();
  assert.deepStrictEqual(ids, sorted, 'ids must sort in creation order');
  assert.strictEqual(new Set(ids).size, 500, 'ids must be unique');
});

test('a malformed record cannot crash list or reconcile, or escape the cap', () => {
  const root = tmpRoot();
  const good = orders.create(root, { projectId: 'p', prompt: 'x' });
  const store = require('../lib/store');
  // Sorts BEFORE the real id, which is the position that used to throw.
  store.writeJson(root, 'orders/ord-000000AAAA.json', { id: 'ord-000000AAAA', createdAt: 12345 });
  store.writeJson(root, 'orders/ord-000000BBBB.json', 'not even an object');

  const all = orders.list(root);
  assert.strictEqual(all.length, 1, 'malformed records must be skipped, not thrown on');
  assert.strictEqual(all[0].id, good.id);
  assert.strictEqual(orders.reconcile(root), 0, 'boot must not crash on a malformed record');
  assert.strictEqual(orders.countToday(root, 'p'), 1, 'an undateable record must not inflate or escape the count');
});

test('an undateable record carrying a real projectId cannot escape the cap', () => {
  // The fail-open countToday used to have: a non-string createdAt reaches
  // localDay, yields NaN-NaN-NaN, and matches nothing - so the order exists but
  // never counts against the day's budget. usable() is what closes it, so the
  // record has to share the projectId being counted or the filter hides the bug.
  const root = tmpRoot();
  orders.create(root, { projectId: 'p', prompt: 'x' });
  require('../lib/store').writeJson(root, 'orders/ord-000000CCCC.json',
    { id: 'ord-000000CCCC', projectId: 'p', createdAt: 12345, status: 'queued' });
  assert.strictEqual(orders.countToday(root, 'p'), 1);
});

test('a contradictory exit code and error fails safe, never succeeds', () => {
  // exitCode 0 with an error is a caller mistake, and the safe reading is
  // failure: this module's thesis is that exiting zero is not evidence of
  // having done the right thing. The suite could not previously tell the
  // fail-safe from a plain `exitCode === 0` check.
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  orders.markRunning(root, o.id, { cwd: '/tmp', agent: 'a' });
  const done = orders.markFinished(root, o.id, { exitCode: 0, error: 'cancelled' });
  assert.strictEqual(done.status, 'failed');
});

test('an over-long acceptance is rejected, and a present one is trimmed', () => {
  // acceptance is what a verdict gets judged against in plan 2b. Truncating it
  // destroys the criterion on disk while leaving something that still reads as
  // a criterion.
  const root = tmpRoot();
  assert.throws(
    () => orders.create(root, { projectId: 'p', prompt: 'x', acceptance: 'a'.repeat(100001) }),
    /acceptance is too long/
  );
  const ok = orders.create(root, { projectId: 'p', prompt: 'x', acceptance: '  tests pass  ' });
  assert.strictEqual(ok.acceptance, 'tests pass', 'acceptance is trimmed like its peers');
  // Absent or blank stays the empty string rather than becoming null.
  assert.strictEqual(orders.create(root, { projectId: 'p', prompt: 'x' }).acceptance, '');
  assert.strictEqual(orders.create(root, { projectId: 'p', prompt: 'x', acceptance: '   ' }).acceptance, '');
});

test('markFailed with no message does not record an error named "undefined"', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  const done = orders.markFailed(root, o.id);
  assert.strictEqual(done.status, 'failed');
  assert.notStrictEqual(done.error, 'undefined');
  assert.match(done.error, /unspecified/);
});

test('title truncation never splits a surrogate pair', () => {
  const root = tmpRoot();
  // 300 astral-plane code points: a naive slice(0, 200) cuts one in half and
  // leaves a lone high surrogate, which renders as a replacement glyph.
  const o = orders.create(root, { projectId: 'p', prompt: 'x', title: '\u{1F600}'.repeat(300) });
  assert.strictEqual(Array.from(o.title).length, 200, 'truncated by code point, not code unit');
  assert.ok(!/[\uD800-\uDBFF]$/.test(o.title), 'must not end on a lone high surrogate');
});

test('attachToGoal fills the reserved fields', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  assert.strictEqual(o.goalId, null);
  assert.strictEqual(o.seq, null);
  const linked = orders.attachToGoal(root, o.id, 'goal-1', 3);
  assert.strictEqual(linked.goalId, 'goal-1');
  assert.strictEqual(linked.seq, 3);
  assert.strictEqual(orders.get(root, o.id).goalId, 'goal-1');
  assert.strictEqual(orders.get(root, o.id).seq, 3);
});

test('attachToGoal refuses a link it could only write as "not attached"', () => {
  // String(null) writes the literal "null" as a goal id, and Number('x') writes
  // NaN - which JSON.stringify turns into `null` on disk, the exact value that
  // means the field was never set. Either coercion produces an order that reads
  // as attached to a goal nothing can find, or attached with no position.
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  for (const badGoal of [null, undefined, '', '   ', 7, {}]) {
    assert.throws(() => orders.attachToGoal(root, o.id, badGoal, 0), /goalId is required/);
  }
  for (const badSeq of [null, undefined, NaN, -1, 1.5, '0']) {
    assert.throws(() => orders.attachToGoal(root, o.id, 'goal-1', badSeq), /seq must be/);
  }
  assert.strictEqual(orders.get(root, o.id).goalId, null, 'a refused link still wrote');
  assert.strictEqual(orders.get(root, o.id).seq, null, 'a refused link still wrote');
});

// A settled order with a real startedAt, the shape a dispatched one has.
function settledOrder(root, exitCode = 0) {
  const o = orders.create(root, { projectId: 'p', prompt: 'x', acceptance: 'y' });
  orders.markRunning(root, o.id, { cwd: '/tmp/w', agent: 'fake' });
  return orders.markFinished(root, o.id, { exitCode });
}

test('a new order carries an empty verdict, not a missing one', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  for (const k of ['verdict', 'verdictReason', 'verdictState', 'verdictError', 'verdictRaw',
    'verdictAgent', 'verdictLog', 'verdictStartedAt', 'verdictAt', 'retryRefused', 'supersedes']) {
    assert.strictEqual(o[k], null, `${k} must start null`);
  }
  assert.strictEqual(o.verdictRuns, 0);
});

test('supersedes is accepted at creation and validated, never coerced', () => {
  const root = tmpRoot();
  const a = orders.create(root, { projectId: 'p', prompt: 'x' });
  const b = orders.create(root, { projectId: 'p', prompt: 'x', supersedes: a.id });
  assert.strictEqual(orders.get(root, b.id).supersedes, a.id, 'not persisted');
  assert.strictEqual(orders.create(root, { projectId: 'p', prompt: 'x', supersedes: null }).supersedes, null);
  // A path, a flag, a number: each would otherwise become a chain edge a reader
  // follows into store.abs() - which THROWS on '../', taking a GET down with it.
  for (const bad of [5, {}, '../escape', '-flag', 'has space', '']) {
    assert.throws(
      () => orders.create(root, { projectId: 'p', prompt: 'x', supersedes: bad }),
      /supersedes must be an order id/, `accepted ${JSON.stringify(bad)}`
    );
  }
});

test('recordVerdict writes verdict fields on a settled order, and only those', () => {
  const root = tmpRoot();
  const o = settledOrder(root);
  const v = orders.recordVerdict(root, o.id, {
    verdictState: 'judged', verdict: 'rejected', verdictReason: 'no test', verdictAt: 't',
  });
  assert.strictEqual(v.verdict, 'rejected');
  assert.strictEqual(v.status, 'succeeded', 'a verdict is not a status');
  assert.throws(() => orders.recordVerdict(root, o.id, { status: 'failed' }), /not verdict fields: status/);
  assert.throws(() => orders.recordVerdict(root, o.id, { verdict: 'pass' }), /verdict must be/);
  assert.throws(() => orders.recordVerdict(root, o.id, { verdictState: 'done' }), /verdictState must be/);
});

test('recordVerdict refuses an order that has not settled', () => {
  // A verdict on live work judges work still being done.
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  assert.strictEqual(orders.recordVerdict(root, o.id, { verdictState: 'judging' }).verdictState, null);
  assert.strictEqual(orders.recordVerdict(root, 'ord-nope', { verdictState: 'judging' }), null);
});

test('a judged verdict is permanent, and retryRefused is written once', () => {
  const root = tmpRoot();
  const o = settledOrder(root);
  orders.recordVerdict(root, o.id, { verdictState: 'judged', verdict: 'rejected', verdictReason: 'r' });
  assert.strictEqual(orders.recordVerdict(root, o.id, { verdict: 'verified' }).verdict, 'rejected');
  assert.strictEqual(orders.recordVerdict(root, o.id, { verdictState: 'error' }).verdictState, 'judged');
  const first = 'no attempts left (3 of 3)';
  assert.strictEqual(orders.recordVerdict(root, o.id, { retryRefused: first }).retryRefused, first);
  assert.strictEqual(orders.recordVerdict(root, o.id, { retryRefused: 'second' }).retryRefused, first);
  assert.throws(() => orders.recordVerdict(root, o.id, { retryRefused: 'x', verdictReason: 'y' }),
    /retryRefused is written on its own/);
});

test('retryRefused belongs to a rejected verdict and nothing else', () => {
  const root = tmpRoot();
  const o = settledOrder(root);
  assert.strictEqual(orders.recordVerdict(root, o.id, { retryRefused: 'x' }).retryRefused, null,
    'refused a retry of an order nobody judged');
  orders.recordVerdict(root, o.id, { verdictState: 'judged', verdict: 'verified', verdictReason: 'ok' });
  assert.strictEqual(orders.recordVerdict(root, o.id, { retryRefused: 'x' }).retryRefused, null,
    'refused a retry of a verified order');
});

test('a verdict write leaves every non-verdict field exactly as it was', () => {
  // Spec 12: the rejected order keeps its status, log and verdict permanently.
  // This is THE guard for "never mutated except for its verdict fields".
  const root = tmpRoot();
  const o = settledOrder(root, 3);
  const before = orders.get(root, o.id);
  orders.recordVerdict(root, o.id, { verdictState: 'judging', verdictRuns: 1, verdictAgent: 'fake' });
  orders.recordVerdict(root, o.id, { verdictState: 'judged', verdict: 'rejected', verdictReason: 'r', verdictAt: 't' });
  orders.recordVerdict(root, o.id, { retryRefused: 'cap' });
  const after = orders.get(root, o.id);
  for (const k of Object.keys(before)) {
    if (orders.VERDICT_FIELDS.has(k)) continue;
    assert.deepStrictEqual(after[k], before[k], `${k} changed under a verdict write`);
  }
});

test('reconcileVerdicts records an interrupted judgement and touches nothing else', () => {
  const root = tmpRoot();
  const a = settledOrder(root);
  orders.recordVerdict(root, a.id, { verdictState: 'judging', verdictRuns: 1 });
  const b = settledOrder(root);
  orders.recordVerdict(root, b.id, { verdictState: 'judged', verdict: 'verified', verdictReason: 'ok' });
  const c = orders.create(root, { projectId: 'p', prompt: 'x' });

  assert.strictEqual(orders.reconcileVerdicts(root), 1);
  const ra = orders.get(root, a.id);
  assert.strictEqual(ra.verdictState, 'error');
  assert.strictEqual(ra.verdictError, 'interrupted while judging');
  assert.ok(ra.verdictAt, 'an error is a moment, not only a state');
  assert.strictEqual(ra.verdict, null, 'an interrupted judgement is not a verdict');
  assert.strictEqual(ra.verdictRuns, 1, 'reconcile must not invent a run');
  assert.strictEqual(orders.get(root, b.id).verdictState, 'judged');
  assert.strictEqual(orders.get(root, c.id).verdictState, null);
});

test('a record written before verdicts existed can still be judged', () => {
  // Every store that ran 2a-2c holds orders with NONE of the verdict keys. They
  // must read as unjudged, not as malformed.
  const root = tmpRoot();
  const id = orders.newId();
  store.writeJson(root, `orders/${id}.json`, {
    id, projectId: 'p', goalId: 'goal-x', seq: 0, title: '', prompt: 'old', acceptance: '',
    agent: 'fake', cwd: '/w', status: 'succeeded', exitCode: 0, verdict: null, error: null,
    supersedes: null, createdAt: new Date().toISOString(), startedAt: 't', finishedAt: 't',
  });
  const r = orders.recordVerdict(root, id, { verdictState: 'judging', verdictRuns: 1 });
  assert.strictEqual(r.verdictState, 'judging');
});
