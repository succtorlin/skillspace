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
function gitCommit(cwd, message) {
  execSync(`git -c user.email=t@t -c user.name=t commit -q -m ${message}`, { cwd });
}
function tmpGitRepo() {
  const d = tmpDir('skillspace-wtrepo-');
  execSync('git init -q', { cwd: d });
  fs.writeFileSync(path.join(d, 'file.txt'), 'original\n');
  execSync('git add -A', { cwd: d });
  gitCommit(d, 'init');
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
  const r = await worktrees.cleanup(wt);
  assert.deepStrictEqual(
    r,
    { removed: false, committed: false, branchKept: false, ignoredOutput: 0, preserveError: null },
    'a dir project must report that nothing was removed, committed or kept'
  );
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
  const r = await worktrees.cleanup(wt);
  assert.strictEqual(r.removed, true, 'the worktree was removed');
  assert.strictEqual(r.committed, false, 'an agent that changed nothing must not produce a commit');
  assert.strictEqual(r.branchKept, true, 'the git path always keeps its branch');
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
  // file.txt is on every branch, so asserting it exists proves nothing about
  // which branch was checked out. Give each branch a file only it has.
  const repo = tmpGitRepo();
  const c = { cwd: repo };
  execSync('git checkout -q -b feature-x', c);
  fs.writeFileSync(path.join(repo, 'branch-only.txt'), 'on feature-x\n');
  execSync('git add -A', c); gitCommit(repo, 'feature');
  execSync('git checkout -q -', c);
  fs.writeFileSync(path.join(repo, 'main-only.txt'), 'on the default branch\n');
  execSync('git add -A', c); gitCommit(repo, 'main');

  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo, branch: 'feature-x' }, 'ord-eee');
  assert.ok(fs.existsSync(path.join(wt.cwd, 'branch-only.txt')), 'the worktree was not based on feature-x');
  assert.ok(!fs.existsSync(path.join(wt.cwd, 'main-only.txt')), 'the worktree was based on HEAD, not the requested branch');
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
  gitCommit(repo, 'ignore');

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

test('a failed prepare does not delete a branch it did not create', async () => {
  // The failure path deletes the branch it made, but a prepare that fails
  // *because* the branch already exists must leave that one alone: it is the
  // previous order's preserved record, which is what retention is for.
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const first = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord_reuse');
  fs.writeFileSync(path.join(first.cwd, 'precious.txt'), 'a previous order\n');
  await worktrees.cleanup(first);

  await assert.rejects(() => worktrees.prepare(root, { kind: 'git', path: repo }, 'ord_reuse'));

  // Assert the branch first: without it this fails as a raw "Not a valid object
  // name" from ls-tree, which does not say what actually went wrong.
  const branches = execSync('git branch --list', { cwd: repo, encoding: 'utf8' });
  assert.ok(
    branches.includes('skillspace/ord_reuse'),
    "a previous order's preserved record was deleted by a later failed prepare"
  );
  const files = execSync('git ls-tree -r --name-only skillspace/ord_reuse', { cwd: repo, encoding: 'utf8' });
  assert.match(files, /precious\.txt/, "a previous order's preserved record was emptied");
});

test('a cleanup that commits real work still excludes ignored output', async () => {
  // The earlier test's agent wrote ONLY ignored files, so the commit block was
  // never entered and "not committed" was true for the wrong reason.
  const repo = tmpGitRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n.env\nnode_modules/\n');
  execSync('git add -A', { cwd: repo });
  gitCommit(repo, 'ignore');

  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord_mixed');
  fs.writeFileSync(path.join(wt.cwd, 'src.js'), 'real work\n');          // tracked
  fs.mkdirSync(path.join(wt.cwd, 'dist'));
  fs.writeFileSync(path.join(wt.cwd, 'dist', 'build.js'), 'output\n');   // ignored
  fs.writeFileSync(path.join(wt.cwd, '.env'), 'SECRET=1\n');             // ignored
  fs.mkdirSync(path.join(wt.cwd, 'node_modules'));
  fs.writeFileSync(path.join(wt.cwd, 'node_modules', 'dep.js'), 'x\n');  // ignored

  const r = await worktrees.cleanup(wt);
  assert.strictEqual(r.committed, true, 'the tracked change must be committed');
  // Porcelain ENTRIES, not files: dist/ and node_modules/ each collapse to one
  // line, so three ignored paths read as exactly 3.
  assert.strictEqual(r.ignoredOutput, 3, `expected 3 ignored entries, got ${r.ignoredOutput}`);

  const files = execSync(`git ls-tree -r --name-only ${wt.branch}`, { cwd: repo, encoding: 'utf8' });
  assert.match(files, /src\.js/, 'the real work was not preserved');
  for (const bad of ['dist/build.js', '.env', 'node_modules/dep.js']) {
    assert.ok(!files.includes(bad), `${bad} was committed into the user's repo`);
  }
});

test('ambient git env vars cannot retarget the worktree or the snapshot', async () => {
  // A GIT_DIR inherited from a hook or a parent process would otherwise make
  // git operate on a different repository than the project entirely, and a
  // GIT_INDEX_FILE from that same hook diverts the preservation commit - the
  // agent's work would be staged through a foreign index and never land.
  const repo = tmpGitRepo();
  fs.writeFileSync(path.join(repo, 'real-only.txt'), 'the real project\n');
  execSync('git add -A', { cwd: repo });
  gitCommit(repo, 'real');

  const decoy = tmpGitRepo();
  fs.writeFileSync(path.join(decoy, 'decoy-only.txt'), 'the wrong project\n');
  execSync('git add -A', { cwd: decoy });
  gitCommit(decoy, 'decoy');

  const root = tmpDir('skillspace-wthome-');
  const VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  let wt, r;
  try {
    process.env.GIT_DIR = path.join(decoy, '.git');
    process.env.GIT_WORK_TREE = decoy;
    process.env.GIT_INDEX_FILE = path.join(decoy, '.git', 'foreign-index');
    wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord_env');
    assert.ok(fs.existsSync(path.join(wt.cwd, 'real-only.txt')), 'the worktree was not built from the project');
    assert.ok(!fs.existsSync(path.join(wt.cwd, 'decoy-only.txt')), 'an ambient GIT_DIR retargeted the worktree at another repo');
    // the agent works, and the snapshot must be staged through OUR index
    fs.writeFileSync(path.join(wt.cwd, 'agent-output.txt'), 'the work\n');
    r = await worktrees.cleanup(wt);
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  assert.strictEqual(r.committed, true, `the snapshot commit failed: ${r.preserveError}`);
  const files = execSync(`git ls-tree -r --name-only ${wt.branch}`, { cwd: repo, encoding: 'utf8' });
  assert.match(files, /agent-output\.txt/, 'an ambient GIT_INDEX_FILE diverted the snapshot commit');
});

test("the user's pre-commit hook does not block preserving the agent's work", async () => {
  // A linked worktree shares the common dir's hooks, so husky/lint-staged fires
  // on our snapshot - and agent-written code failing lint is the normal case,
  // not an exotic one. Their commit policy must not cost the agent its work.
  const repo = tmpGitRepo();
  const hookDir = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
  fs.chmodSync(path.join(hookDir, 'pre-commit'), 0o755);

  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord_hookfail');
  fs.writeFileSync(path.join(wt.cwd, 'agent-output.txt'), 'the only copy\n');

  const r = await worktrees.cleanup(wt);
  assert.strictEqual(r.committed, true, "the user's lint policy blocked our snapshot commit");
  assert.strictEqual(r.preserveError, null);
  const files = execSync(`git ls-tree -r --name-only ${wt.branch}`, { cwd: repo, encoding: 'utf8' });
  assert.match(files, /agent-output\.txt/, 'the work was not preserved');
});

test('work that cannot be committed is kept, not deleted and reported as nothing', async () => {
  // --no-verify and gpgsign=false deliberately neutralise the hook and signing
  // triggers, so the residual failure class is environmental: a full disk or an
  // unwritable object store. That is what this simulates.
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord_nosave');
  fs.writeFileSync(path.join(wt.cwd, 'agent-output.txt'), 'the only copy\n');

  const objects = path.join(repo, '.git', 'objects');
  let r;
  try {
    execSync(`chmod -R 555 ${objects}`);
    r = await worktrees.cleanup(wt);
  } finally {
    execSync(`chmod -R 755 ${objects}`); // so the fixture can be torn down
  }

  assert.strictEqual(r.committed, false);
  assert.ok(r.preserveError, 'a failed preservation must be distinguishable from an agent that did nothing');
  assert.strictEqual(r.removed, false, 'a tree holding the only copy of the work must not be removed');
  assert.ok(
    fs.existsSync(path.join(wt.cwd, 'agent-output.txt')),
    "the only copy of the agent's work was deleted"
  );
});

test('cleanup refuses a persisted record whose cwd is the project itself', async () => {
  // wt round-trips through persistence, so a corrupted record must not turn
  // cleanup into "delete the user's entire project" and report all-clear.
  const dir = tmpDir('skillspace-plain-');
  fs.writeFileSync(path.join(dir, 'user-work.txt'), 'not ours to delete\n');
  const forged = {
    cwd: dir, isolated: true, branch: 'skillspace/ord_forged',
    projectPath: dir, orderId: 'ord_forged',
  };

  const r = await worktrees.cleanup(forged);
  assert.strictEqual(r.removed, false);
  assert.match(r.preserveError, /cwd is the project itself/);
  assert.ok(
    fs.existsSync(path.join(dir, 'user-work.txt')),
    "cleanup deleted the user's project from a persisted record"
  );
});

test('cleanup is safe to call twice', async () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord-ggg');
  await worktrees.cleanup(wt);
  await worktrees.cleanup(wt); // must not throw
  assert.ok(!fs.existsSync(wt.cwd));
});
