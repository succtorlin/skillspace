'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const chains = require('../lib/chains');

// A settled, judged-nothing goal order. Every test overrides what it is about.
function rec(id, extra) {
  return {
    id, goalId: 'g', status: 'succeeded', startedAt: 't', supersedes: null,
    verdictState: null, verdict: null, retryRefused: null, verdictReason: null,
    ...(extra || {}),
  };
}
const verified = (id, extra) => rec(id, { verdictState: 'judged', verdict: 'verified', ...extra });
const rejected = (id, extra) => rec(id, { verdictState: 'judged', verdict: 'rejected', verdictReason: 'no test', ...extra });

test('a chain is read from supersedes, oldest first', () => {
  const idx = chains.index([rec('a'), rec('b', { supersedes: 'a' }), rec('c', { supersedes: 'b' }), rec('x')]);
  assert.deepStrictEqual(idx.chainOf('b'), {
    rootId: 'a', headId: 'c', ids: ['a', 'b', 'c'],
    attempt: 2, attempts: 3, supersedes: 'a', supersededBy: 'c',
  });
  assert.deepStrictEqual(idx.chainOf('x'), {
    rootId: 'x', headId: 'x', ids: ['x'], attempt: 1, attempts: 1, supersedes: null, supersededBy: null,
  });
  assert.strictEqual(idx.chainOf('nope'), null);
});

test('a supersedes outside the family starts a chain rather than breaking one', () => {
  // A human retry of an order whose predecessor was quarantined by the store.
  const idx = chains.index([rec('b', { supersedes: 'gone' })]);
  assert.strictEqual(idx.chainOf('b').attempt, 1);
  assert.strictEqual(idx.chainOf('b').supersedes, null);
});

test('a hand-edited cycle does not hang a reader', () => {
  const idx = chains.index([rec('a', { supersedes: 'b' }), rec('b', { supersedes: 'a' })]);
  const c = idx.chainOf('a');
  assert.ok(c.ids.length <= 2, `walked ${c.ids.length}`);
  assert.ok(new Set(c.ids).size === c.ids.length, 'an id appears twice');
});

test('a fork keeps the oldest successor', () => {
  // attempts.supersede makes this impossible; a hand edit or a second process
  // does not. The oldest id is the one created first (orders.newId).
  const idx = chains.index([rec('a'), rec('c', { supersedes: 'a' }), rec('b', { supersedes: 'a' })]);
  assert.strictEqual(idx.chainOf('a').supersededBy, 'b');
});

test('what can be judged, and why not', () => {
  assert.strictEqual(chains.judgeable(rec('a')), null);
  assert.strictEqual(chains.judgeable(rec('a', { status: 'failed', exitCode: 2 })), null, 'spec 10');
  assert.strictEqual(chains.judgeable(rec('a', { status: 'failed', error: 'timeout' })), null);
  assert.match(chains.judgeable(rec('a', { status: 'failed', startedAt: null })), /never ran/);
  assert.match(chains.judgeable(rec('a', { status: 'cancelled' })), /cancelled/);
  assert.match(chains.judgeable(rec('a', { status: 'interrupted' })), /interrupted/);
  assert.match(chains.judgeable(rec('a', { status: 'queued' })), /queued/);
  assert.match(chains.judgeable(rec('a', { goalId: null })), /outside a goal/);
  assert.match(chains.judgeable(null), /no order/);
});

test('an absent verdict field reads as null', () => {
  const legacy = rec('a');
  delete legacy.verdictState;
  assert.strictEqual(chains.verdictStateOf(legacy), null);
});

test('a chain head says what is left to do', () => {
  const h = chains.headState;
  assert.strictEqual(h(rec('a'), true), 'busy');
  assert.strictEqual(h(undefined, false), 'missing');
  assert.strictEqual(h(rec('a', { status: 'queued' }), false), 'pending');
  assert.strictEqual(h(rec('a', { status: 'running' }), false), 'pending');
  assert.strictEqual(h(rec('a'), false), 'pending', 'awaiting its verdict');
  assert.strictEqual(h(rec('a', { verdictState: 'judging' }), false), 'pending');
  assert.strictEqual(h(verified('a'), false), 'verified');
  assert.strictEqual(h(rejected('a'), false), 'pending', 'its retry is on the way');
  assert.strictEqual(h(rejected('a', { retryRefused: 'cap' }), false), 'rejected');
  assert.strictEqual(h(rec('a', { verdictState: 'error' }), false), 'stuck');
  assert.strictEqual(h(rec('a', { status: 'cancelled' }), false), 'stuck');
  assert.strictEqual(h(rec('a', { status: 'interrupted' }), false), 'stuck');
  assert.strictEqual(h(rec('a', { status: 'failed', startedAt: null }), false), 'stuck');
  assert.strictEqual(h(rec('a', { status: 'weird' }), false), 'pending', 'fail closed: never done over it');
});

test('a goal outcome is read from its chain heads only', () => {
  const outcome = (records, busy = []) => {
    const byId = new Map(records.map((r) => [r.id, r]));
    return chains.goalOutcome({ orderIds: records.map((r) => r.id) }, byId, (id) => busy.includes(id));
  };
  assert.strictEqual(outcome([verified('a'), verified('b')]).status, 'done');
  assert.strictEqual(outcome([verified('a'), rec('b')], ['b']).status, 'running');
  assert.strictEqual(outcome([verified('a'), rec('b')]).status, 'planned', 'awaiting a verdict');
  assert.strictEqual(outcome([verified('a'), rejected('b')]).status, 'planned', 'retry coming');
  assert.strictEqual(outcome([verified('a'), rec('b', { verdictState: 'error' })]).status, 'stalled');
  // A superseded attempt does not count; its successor does.
  assert.strictEqual(outcome([rejected('a'), verified('b', { supersedes: 'a' })]).status, 'done');

  const failed = outcome([verified('a'), rejected('b', { retryRefused: 'no attempts left (3 of 3)' })]);
  assert.strictEqual(failed.status, 'failed');
  assert.match(failed.error, /\bb\b.*no attempts left \(3 of 3\).*no test/);

  // PRECEDENCE. Final rejection beats a stuck head: the goal cannot succeed.
  assert.strictEqual(outcome([rejected('a', { retryRefused: 'cap' }), rec('b', { status: 'cancelled' })]).status, 'failed');
  // But outstanding work beats both: no fail-fast while anything is still
  // coming, or the final record depends on which order finished first.
  assert.strictEqual(outcome([rejected('a', { retryRefused: 'cap' }), rec('b')]).status, 'planned');
});

test('a missing order is never read as finished', () => {
  const byId = new Map([['a', verified('a')]]);
  assert.strictEqual(chains.goalOutcome({ orderIds: ['a', 'gone'] }, byId, () => false).status, 'planned');
});

test('an empty or malformed goal has no outcome', () => {
  assert.strictEqual(chains.goalOutcome({ orderIds: [] }, new Map(), () => false), null);
  assert.strictEqual(chains.goalOutcome({ orderIds: 'x' }, new Map(), () => false), null);
});
