'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const orders = require('../lib/orders');
const goals = require('../lib/goals');
const { startQuietServer, stopQuietServer } = require('./helpers/quiet-server');

const created = [];
let srv;
before(async () => { srv = await startQuietServer(created); });
after(async () => {
  await stopQuietServer(srv && srv.proc);
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function writeLog(id, content) {
  fs.mkdirSync(path.join(srv.store, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(srv.store, 'logs', `${id}.log`), content);
}
async function get(p, method = 'GET') {
  const r = await fetch(srv.base + p, { method });
  let body = null;
  try { body = await r.json(); } catch (_) {}
  return { status: r.status, body };
}

test('GET /api/orders/:id/log returns a slice and the record status', async () => {
  const o = orders.create(srv.store, { projectId: 'p1', prompt: 'x' });
  writeLog(o.id, 'hello\nworld\n');
  const a = await get(`/api/orders/${o.id}/log`);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.body.log.text, 'hello\nworld\n');
  assert.strictEqual(a.body.log.next, 12);
  assert.strictEqual(a.body.log.exists, true);
  assert.strictEqual(a.body.status, 'queued');
  const b = await get(`/api/orders/${o.id}/log?from=6`);
  assert.strictEqual(b.body.log.text, 'world\n');
});

test('an order with no log yet answers 200 with exists:false, not 404', async () => {
  // A queued order has no log. 404 would read as "no such order" to a client
  // that polls, and it would stop.
  const o = orders.create(srv.store, { projectId: 'p1', prompt: 'x' });
  const r = await get(`/api/orders/${o.id}/log`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.log.exists, false);
  assert.strictEqual(r.body.log.next, 0);
});

test('the log of an unknown order is 404, of a bad id 400', async () => {
  assert.strictEqual((await get('/api/orders/ord-nope/log')).status, 404);
  assert.strictEqual((await get('/api/orders/..%2Fprojects/log')).status, 400);
});

test('the log route answers GET only', async () => {
  // routes/scheduler.js records why: a handler that answers every verb is the
  // shape that once let a GET spawn an agent. Anything else falls through.
  const o = orders.create(srv.store, { projectId: 'p1', prompt: 'x' });
  const r = await get(`/api/orders/${o.id}/log`, 'POST');
  assert.notStrictEqual(r.status, 200);
});

test("GET /api/goals/:id/log serves the PM's output with the goal status", async () => {
  const g = goals.create(srv.store, { projectId: 'p1', text: 'do a thing' });
  writeLog(g.id, 'reading the project…\n');
  const r = await get(`/api/goals/${g.id}/log`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.log.text, 'reading the project…\n');
  assert.strictEqual(r.body.status, 'planning');
  assert.strictEqual((await get('/api/goals/goal-nope/log')).status, 404);
});
