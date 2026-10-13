'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const consoleLink = require('../lib/console-link');

const created = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); created.push(d); return d; };
after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });

const SCRIPT = path.join(__dirname, '..', 'scripts', 'open-console.mjs');
const LINK = `http://localhost:4199/?auth=${'ab'.repeat(32)}`;

test('the console-link location: SKILLSPACE_HOME when set, never ~/.skillspace otherwise', () => {
  assert.strictEqual(consoleLink.defaultFile({ SKILLSPACE_HOME: '/x/y' }), '/x/y/console-link');
  const real = consoleLink.defaultFile({});
  assert.ok(!real.startsWith(path.join(os.homedir(), '.skillspace')), real);
  if (process.platform === 'darwin') {
    assert.strictEqual(real, path.join(os.homedir(), 'Library', 'Application Support', 'SkillSpace', 'console-link'));
  }
});

test('write is 0600 and replaces; remove only removes this boot\'s link', () => {
  const file = path.join(tmp('skillspace-cl-'), 'sub', 'console-link');
  consoleLink.write(file, 'one');
  consoleLink.write(file, LINK);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), LINK);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['console-link'], 'no temp file left behind');
  consoleLink.remove(file, 'one');
  assert.ok(fs.existsSync(file), "another boot's link was removed");
  consoleLink.remove(file, LINK);
  assert.ok(!fs.existsSync(file));
});

test('npm run open opens the link the file holds, and refuses a file that is not a link', () => {
  // SKILLSPACE_HOME set, so the real location is never read, and a PATH whose
  // `open` is a recorder, so no browser is launched.
  const home = tmp('skillspace-clhome-');
  const bin = tmp('skillspace-clbin-');
  const rec = path.join(bin, 'opened');
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\nprintf '%s' "$1" > "${rec}"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SKILLSPACE_HOME: home };
  const missing = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /No console link/);

  consoleLink.write(path.join(home, 'console-link'), LINK);
  execFileSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  if (process.platform === 'darwin') assert.strictEqual(fs.readFileSync(rec, 'utf8'), LINK);

  consoleLink.write(path.join(home, 'console-link'), 'file:///etc/passwd');
  const bad = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /refusing/);
});
