'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { startQuietServer, stopQuietServer } = require('./helpers/quiet-server');

const created = [];
let srv;
before(async () => { srv = await startQuietServer(created); });
after(async () => {
  await stopQuietServer(srv && srv.proc);
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

test('the board assets are served, and told not to be cached', async () => {
  // A stale board.js after an edit is how a browser check passes on code that
  // no longer exists. no-cache makes the browser revalidate every load.
  for (const [p, type] of [
    ['/board.css', 'text/css'], ['/board.js', 'text/javascript'],
    ['/order-drawer.js', 'text/javascript'], ['/goal-panel.js', 'text/javascript'],
    ['/app.js', 'text/javascript'], ['/style.css', 'text/css'],
  ]) {
    const r = await fetch(srv.base + p);
    assert.strictEqual(r.status, 200, p);
    assert.ok(r.headers.get('content-type').startsWith(type), `${p}: ${r.headers.get('content-type')}`);
    assert.strictEqual(r.headers.get('cache-control'), 'no-cache', p);
  }
});

test('a file in public/ that is not on the allowlist is not served', async () => {
  // landing.js is in public/ and has its own route; the allowlist is the
  // thing under test, so ask for something that exists and is NOT listed.
  const r = await fetch(srv.base + '/server.js');
  assert.strictEqual(r.status, 404);
});
