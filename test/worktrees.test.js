'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const worktrees = require('../lib/worktrees');

const created = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'skillspace-wt-'));
  created.push(d);
  return d;
}
function tmpGitRepo() {
  const d = tmpDir('skillspace-wtrepo-');
  execSync('git init -q', { cwd: d });
  fs.writeFileSync(path.join(d, 'file.txt'), 'original\n');
  execSync('git add -A', { cwd: d });
  execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: d });
  return d;
}
after(() => {
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

test('a git project gets its own worktree, isolated from the source tree', () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const wt = worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-aaa');

  assert.notStrictEqual(wt.cwd, repo, 'the worktree must not be the project itself');
  assert.ok(wt.isolated, 'a git project is isolated');
  assert.ok(fs.existsSync(path.join(wt.cwd, 'file.txt')), 'the worktree has the repo content');

  // Editing in the worktree must not touch the source tree.
  fs.writeFileSync(path.join(wt.cwd, 'file.txt'), 'changed by the agent\n');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8'), 'original\n');

  worktrees.cleanup(root, wt);
  assert.ok(!fs.existsSync(wt.cwd), 'the worktree is removed on cleanup');
});

test('two orders on one repo get distinct worktrees', () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const a = worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-aaa');
  const b = worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-bbb');
  assert.notStrictEqual(a.cwd, b.cwd);
  assert.ok(fs.existsSync(a.cwd) && fs.existsSync(b.cwd));
  worktrees.cleanup(root, a);
  worktrees.cleanup(root, b);
});

test('a dir project runs in the project itself and says it is not isolated', () => {
  // A plain directory has no isolation mechanism. It is serialised by the
  // caller rather than silently allowed to collide, and the caller must be
  // able to see which it got.
  const dir = tmpDir('skillspace-plain-');
  const root = tmpDir('skillspace-wthome-');
  const wt = worktrees.prepare(root, { kind: 'dir', path: dir }, 'ord-ccc');
  assert.strictEqual(wt.cwd, dir);
  assert.strictEqual(wt.isolated, false);

  // cleanup must be a no-op here - removing it would delete the user's project
  worktrees.cleanup(root, wt);
  assert.ok(fs.existsSync(dir), 'cleanup must never remove a dir project');
});

test('a branch name that could be read as a flag is refused', () => {
  // lib/projects type-checks `branch` but explicitly defers git-ref legality
  // and leading-dash rejection to this call site, because only this site knows
  // the argv it builds. "--force" as a branch name is the injection shape.
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  for (const bad of ['--force', '-x', '--', 'has space', 'has..dots', 'ends.lock', 'has~tilde']) {
    assert.throws(
      () => worktrees.prepare(root, { kind: 'git', path: repo, branch: bad }, 'ord-ddd'),
      /invalid branch/,
      `branch ${JSON.stringify(bad)} was accepted`
    );
  }
});

test('a legitimate branch is used as the base', () => {
  const repo = tmpGitRepo();
  execSync('git branch feature-x', { cwd: repo });
  const root = tmpDir('skillspace-wthome-');
  const wt = worktrees.prepare(root, { kind: 'git', path: repo, branch: 'feature-x' }, 'ord-eee');
  assert.ok(fs.existsSync(path.join(wt.cwd, 'file.txt')));
  worktrees.cleanup(root, wt);
});

test('an order id that is not a plain identifier is refused', () => {
  // The id becomes a directory name and a branch name.
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  for (const bad of ['../escape', 'a/b', '', '-flag']) {
    assert.throws(
      () => worktrees.prepare(root, { kind: 'git', path: repo }, bad),
      /invalid order id/,
      `id ${JSON.stringify(bad)} was accepted`
    );
  }
});

test('a failed prepare leaves nothing behind', () => {
  // Worktree creation failing must abort before any agent spawns and must not
  // leave a half-created directory.
  const notARepo = tmpDir('skillspace-notrepo-');
  const root = tmpDir('skillspace-wthome-');
  assert.throws(
    () => worktrees.prepare(root, { kind: 'git', path: notARepo }, 'ord-fff'),
    /worktree/,
  );
  const wtRoot = path.join(root, 'worktrees');
  const leftover = fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [];
  assert.deepStrictEqual(leftover, [], `prepare left ${JSON.stringify(leftover)} behind`);
});

test('cleanup is safe to call twice', () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const wt = worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-ggg');
  worktrees.cleanup(root, wt);
  worktrees.cleanup(root, wt); // must not throw
  assert.ok(!fs.existsSync(wt.cwd));
});
