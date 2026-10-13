'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startQuietServer, stopQuietServer } = require('./helpers/quiet-server');

// The recent-directories state used to live at <install>/.skillspace.state.json
// whatever SKILLSPACE_HOME said, so every test and demo server read and wrote
// the real install's history - which is also where the console's source list
// comes from.
const LEGACY = path.join(__dirname, '..', '.skillspace.state.json');
const created = [];
let srv, legacyBefore;

before(async () => {
  legacyBefore = fs.existsSync(LEGACY) ? fs.readFileSync(LEGACY, 'utf8') : null;
  srv = await startQuietServer(created);
});
after(async () => {
  await stopQuietServer(srv && srv.proc);
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

test('recent directories are kept under SKILLSPACE_HOME, and the install\'s file is not touched', async () => {
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-statedir-'));
  created.push(skills);
  const r = await fetch(`${srv.base}/api/skills?dir=${encodeURIComponent(skills)}`);
  assert.strictEqual(r.status, 200);

  const state = JSON.parse(fs.readFileSync(path.join(srv.store, 'state.json'), 'utf8'));
  assert.deepStrictEqual(state.recentDirs.slice(0, 1), [skills]);
  const legacyAfter = fs.existsSync(LEGACY) ? fs.readFileSync(LEGACY, 'utf8') : null;
  assert.strictEqual(legacyAfter, legacyBefore, 'a server with its own SKILLSPACE_HOME rewrote the install\'s state');
  const dirs = await (await fetch(`${srv.base}/api/dirs`)).json();
  assert.ok(dirs.dirs.includes(skills));
});
