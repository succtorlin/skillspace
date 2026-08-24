const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const projects = require('../lib/projects');

// Every temp directory this file creates, so the after() hook can take them
// all back. Nothing here may write outside a directory the suite owns.
const created = [];

function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-proj-'));
  created.push(d);
  return d;
}
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-work-'));
  created.push(d);
  return d;
}
function tmpGitRepo() {
  const d = tmpDir();
  execSync('git init -q', { cwd: d });
  return d;
}

after(() => {
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

test('detectKind returns git for a repository', () => {
  assert.strictEqual(projects.detectKind(tmpGitRepo()), 'git');
});

test('detectKind returns dir for a plain directory', () => {
  assert.strictEqual(projects.detectKind(tmpDir()), 'dir');
});

test('create stores a project and returns it with an id', () => {
  const root = tmpRoot();
  const p = projects.create(root, { name: 'Demo', path: tmpDir() });
  assert.ok(p.id);
  assert.strictEqual(p.name, 'Demo');
  assert.strictEqual(projects.list(root).length, 1);
});

test('create rejects a path that does not exist', () => {
  const root = tmpRoot();
  assert.throws(
    () => projects.create(root, { name: 'Nope', path: '/definitely/not/here' }),
    /path does not exist/
  );
});

test('create rejects a path that is a file', () => {
  const root = tmpRoot();
  const f = path.join(tmpDir(), 'a.txt');
  fs.writeFileSync(f, 'x');
  assert.throws(() => projects.create(root, { name: 'File', path: f }), /not a directory/);
});

test('a git project defaults to concurrency 2', () => {
  const root = tmpRoot();
  const p = projects.create(root, { name: 'G', path: tmpGitRepo() });
  assert.strictEqual(p.kind, 'git');
  assert.strictEqual(p.concurrency, 2);
});

test('a dir project is forced to concurrency 1 because it cannot be isolated', () => {
  const root = tmpRoot();
  const p = projects.create(root, { name: 'D', path: tmpDir() });
  assert.strictEqual(p.kind, 'dir');
  assert.strictEqual(p.concurrency, 1);
});

test('a dir project cannot be raised above concurrency 1', () => {
  const root = tmpRoot();
  const p = projects.create(root, { name: 'D', path: tmpDir(), concurrency: 8 });
  assert.strictEqual(p.concurrency, 1);
});

test('every project carries the default budget controls', () => {
  const root = tmpRoot();
  const p = projects.create(root, { name: 'B', path: tmpDir() });
  assert.strictEqual(p.budget.maxOrdersPerGoal, 12);
  assert.strictEqual(p.budget.orderTimeoutMs, 900000);
  assert.strictEqual(p.budget.maxOrdersPerDay, 100);
});

test('remove deletes the record but NEVER the working directory', () => {
  const root = tmpRoot();
  const work = tmpDir();
  fs.writeFileSync(path.join(work, 'keep.txt'), 'precious');
  const p = projects.create(root, { name: 'Safe', path: work });

  projects.remove(root, p.id);

  assert.strictEqual(projects.list(root).length, 0);
  // the user's files are untouched — this is a safety property, not a detail
  assert.ok(fs.existsSync(path.join(work, 'keep.txt')));
});

test('projects survive a reload from disk', () => {
  const root = tmpRoot();
  projects.create(root, { name: 'Persisted', path: tmpDir() });
  const reloaded = projects.list(root);
  assert.strictEqual(reloaded[0].name, 'Persisted');
});
