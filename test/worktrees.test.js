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

test('a git project gets its own worktree, isolated from the source tree', async () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-aaa');

  assert.notStrictEqual(wt.cwd, repo, 'the worktree must not be the project itself');
  assert.ok(wt.isolated, 'a git project is isolated');
  assert.ok(fs.existsSync(path.join(wt.cwd, 'file.txt')), 'the worktree has the repo content');

  // Editing in the worktree must not touch the source tree.
  fs.writeFileSync(path.join(wt.cwd, 'file.txt'), 'changed by the agent\n');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8'), 'original\n');

  await worktrees.cleanup(wt);
  assert.ok(!fs.existsSync(wt.cwd), 'the worktree is removed on cleanup');
});

test('two orders on one repo get distinct worktrees', async () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const a = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-aaa');
  const b = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-bbb');
  assert.notStrictEqual(a.cwd, b.cwd);
  assert.ok(fs.existsSync(a.cwd) && fs.existsSync(b.cwd));
  await worktrees.cleanup(a);
  await worktrees.cleanup(b);
});

test('a dir project runs in the project itself and says it is not isolated', async () => {
  // A plain directory has no isolation mechanism. It is serialised by the
  // caller rather than silently allowed to collide, and the caller must be
  // able to see which it got.
  const dir = tmpDir('skillspace-plain-');
  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'dir', path: dir }, 'ord-ccc');
  assert.strictEqual(wt.cwd, dir);
  assert.strictEqual(wt.isolated, false);

  // cleanup must be a no-op here - removing it would delete the user's project
  await worktrees.cleanup(wt);
  assert.ok(fs.existsSync(dir), 'cleanup must never remove a dir project');
});

test('prepare returns one shape for both kinds', async () => {
  // A caller in another process must be able to rebuild a usable `wt` from
  // what was persisted, and cleanup() needs projectPath and orderId.
  const repo = tmpGitRepo();
  const dir = tmpDir('skillspace-plain-');
  const root = tmpDir('skillspace-wthome-');
  const g = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-shape-g');
  const d = await worktrees.prepare(root, { kind: 'dir', path: dir }, 'ord-shape-d');
  assert.deepStrictEqual(Object.keys(g).sort(), Object.keys(d).sort());
  assert.strictEqual(d.projectPath, dir);
  assert.strictEqual(d.orderId, 'ord-shape-d');
  assert.strictEqual(g.projectPath, repo);
  assert.strictEqual(g.orderId, 'ord-shape-g');
  await worktrees.cleanup(g);
});

test("an agent's uncommitted work survives cleanup on the order branch", async () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-keep');
  fs.writeFileSync(path.join(wt.cwd, 'agent-output.txt'), 'the work\n');

  const r = await worktrees.cleanup(wt);
  assert.strictEqual(r.committed, true);
  assert.ok(!fs.existsSync(wt.cwd), 'the directory is still removed');

  // the work is reachable from the order's branch
  const files = execSync(`git ls-tree -r --name-only ${wt.branch}`, { cwd: repo, encoding: 'utf8' });
  assert.match(files, /agent-output\.txt/, 'the agent output was discarded');
});

test('cleanup keeps the order branch so the result stays inspectable', async () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-branch');
  await worktrees.cleanup(wt);
  const branches = execSync('git branch --list', { cwd: repo, encoding: 'utf8' });
  assert.match(branches, /skillspace\/ord-branch/, 'the branch must survive as the record');
});

test('a leftover worktree directory is refused, not silently deleted', async () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const dest = path.join(root, 'worktrees', 'ord-left');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'previous-work.txt'), 'do not delete me\n');

  await assert.rejects(
    () => worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-left'),
    /already exists and is not empty/
  );
  assert.ok(fs.existsSync(path.join(dest, 'previous-work.txt')), "the previous run's work was destroyed");
});

test('a branch name that could be read as a flag is refused', async () => {
  // lib/projects type-checks `branch` but explicitly defers git-ref legality
  // and leading-dash rejection to this call site, because only this site knows
  // the argv it builds. "--force" as a branch name is the injection shape.
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  for (const bad of ['--force', '-x', '--', 'has space', 'has..dots', 'ends.lock', 'has~tilde']) {
    await assert.rejects(
      () => worktrees.prepare(root, { kind: 'git', path: repo, branch: bad }, 'ord-ddd'),
      /invalid branch/,
      `branch ${JSON.stringify(bad)} was accepted`
    );
  }
});

test('a legitimate branch is used as the base', async () => {
  const repo = tmpGitRepo();
  execSync('git branch feature-x', { cwd: repo });
  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo, branch: 'feature-x' }, 'ord-eee');
  assert.ok(fs.existsSync(path.join(wt.cwd, 'file.txt')));
  await worktrees.cleanup(wt);
});

test('an order id that is not a plain identifier is refused', async () => {
  // The id becomes a directory name and a branch name.
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  for (const bad of ['../escape', 'a/b', '', '-flag']) {
    await assert.rejects(
      () => worktrees.prepare(root, { kind: 'git', path: repo }, bad),
      /invalid order id/,
      `id ${JSON.stringify(bad)} was accepted`
    );
  }
});

test('a failed prepare leaves nothing behind', async () => {
  // Worktree creation failing must abort before any agent spawns and must not
  // leave a half-created directory.
  const notARepo = tmpDir('skillspace-notrepo-');
  const root = tmpDir('skillspace-wthome-');
  await assert.rejects(
    () => worktrees.prepare(root, { kind: 'git', path: notARepo }, 'ord-fff'),
    /worktree: fatal: not a git repository/,
  );
  const wtRoot = path.join(root, 'worktrees');
  const leftover = fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [];
  assert.deepStrictEqual(leftover, [], `prepare left ${JSON.stringify(leftover)} behind`);
});

test('a worktree git created but could not finish is cleaned up', async () => {
  // The not-a-repo case above aborts before git makes the directory, so it
  // never exercises the removal. A failing post-checkout hook does: git creates
  // the worktree fully, then exits non-zero. Repos really do have these hooks
  // (husky, git-lfs, direnv), and no agent has spawned yet, so the half-made
  // tree is git's own and safe to remove.
  const orderId = 'ord-hook';
  const repo = tmpGitRepo();
  // A real hook explains itself on stderr. git's own first line is progress,
  // so this is also what distinguishes the cause from the chatter.
  fs.writeFileSync(
    path.join(repo, '.git', 'hooks', 'post-checkout'),
    '#!/bin/sh\necho "hook rejected the checkout" >&2\nexit 1\n',
    { mode: 0o755 }
  );
  const root = tmpDir('skillspace-wthome-');

  await assert.rejects(
    () => worktrees.prepare(root, { kind: 'git', path: repo }, orderId),
    (e) => {
      // The order records why it failed, so the reason must be the cause and
      // not the progress line git happened to print first.
      assert.match(e.message, /worktree/);
      assert.ok(
        !e.message.includes('Preparing worktree'),
        `the order recorded git's progress line as the cause: ${e.message}`
      );
      return true;
    }
  );
  const wtRoot = path.join(root, 'worktrees');
  const leftover = fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [];
  assert.deepStrictEqual(leftover, [], `prepare left ${JSON.stringify(leftover)} behind`);

  // `worktree add -b` makes the branch before the checkout can fail, and no
  // agent ran, so there is nothing here worth keeping.
  const branches = execSync('git branch --list', { cwd: repo, encoding: 'utf8' });
  assert.ok(!branches.includes(`skillspace/${orderId}`), 'a failed prepare leaked its branch');
});

test('gitignored output is reported, not silently discarded', async () => {
  const repo = tmpGitRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  execSync('git add -A', { cwd: repo });
  execSync('git -c user.email=t@t -c user.name=t commit -q -m ignore', { cwd: repo });

  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-ign');
  fs.mkdirSync(path.join(wt.cwd, 'dist'));
  fs.writeFileSync(path.join(wt.cwd, 'dist', 'build.js'), 'output\n');

  const r = await worktrees.cleanup(wt);
  assert.strictEqual(r.ignoredOutput, 1, 'an agent that only wrote to dist/ must not read as having done nothing');
  // and it is genuinely not committed - we are reporting, not smuggling it in
  const files = execSync(`git ls-tree -r --name-only ${wt.branch}`, { cwd: repo, encoding: 'utf8' });
  assert.ok(!files.includes('dist/build.js'), 'ignored output must not be committed');
});

test('cleanup is safe to call twice', async () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-ggg');
  await worktrees.cleanup(wt);
  await worktrees.cleanup(wt); // must not throw
  assert.ok(!fs.existsSync(wt.cwd));
});
