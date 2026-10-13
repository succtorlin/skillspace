'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const worktrees = require('../lib/worktrees');
const projects = require('../lib/projects');

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
// Hooks no longer run under SkillSpace's own git (lib/git.js), so a test that
// needs `worktree add` to be slow or to fail after creating the tree puts a
// wrapper ahead of the real git on PATH instead. lib/git passes PATH through.
// `onAdd` is shell run in place of nothing, after the real add, only for
// `worktree add`.
async function withGitWrapper(onAdd, fn) {
  const realGit = execSync('command -v git', { encoding: 'utf8' }).trim();
  const bin = tmpDir('skillspace-gitwrap-');
  fs.writeFileSync(path.join(bin, 'git'),
    '#!/bin/sh\n' +
    'case " $* " in\n' +
    `  *" worktree add "*) "${realGit}" "$@" || exit $?\n${onAdd}\n    exit 0 ;;\n` +
    'esac\n' +
    `exec "${realGit}" "$@"\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try { return await fn(); } finally { process.env.PATH = saved; }
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
  // never exercises the removal. A git that creates the worktree fully and
  // then exits non-zero does - which is what a failing post-checkout hook did
  // before SkillSpace stopped running hooks (lib/git.js); a wrapper stands in
  // for it now. No agent has spawned yet, so the half-made tree is git's own
  // and safe to remove.
  const orderId = 'ord-hook';
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');

  await withGitWrapper('    echo "Preparing worktree (new branch)" >&2\n    echo "error: rejected the checkout" >&2\n    exit 1', () =>
    assert.rejects(
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
    ));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('concurrent prepares on one repo do not race git', async () => {
  // `git worktree add` on one repo fails probabilistically at any K>=2: one add
  // enumerates .git/worktrees/*/commondir while another is mid-creation of its
  // own, and reads a file that exists but is not yet written.
  //   fatal: failed to read .git/worktrees/<id>/commondir: Undefined error: 0
  // It fails closed, so the cost is a legitimate order failing spuriously.
  //
  // HONEST LIMIT OF THIS TEST: one run is one trial, and a trial catches the
  // unmutexed bug ~6% of the time: run 100 times with the mutex removed it
  // failed 6 times, and 0/100 with it. Raising N does not rescue that: the
  // rate does climb with N (8/80 at N=8, 3/30 at N=16, 13/50 at N=32) but only
  // to ~26% at roughly 4x the runtime, which is still nowhere near a gate.
  // Batch-to-batch spread at one N is wide - 40% then 17% at N=32 - so none of
  // these figures is precise enough to plan against, and an earlier version of
  // this comment wrongly called them a plateau.
  // Deliberate CPU load did not move it either (2/20 at N=8), and staggering
  // the starts CLOSED the window entirely (0/20 at 5/15/40ms): the race needs
  // simultaneous cold starts. N=8 is therefore the cheapest N that reproduces,
  // and this test is a net that must be run repeatedly to be trusted - which
  // is how the mutation check below scores it.
  const root = tmpDir('skillspace-wthome-');
  const repo = tmpGitRepo();
  const project = { kind: 'git', path: repo };

  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      worktrees.prepare(root, project, `ord_mutex_${i}`).then(
        (wt) => ({ ok: true, wt }),
        (e) => ({ ok: false, message: e.message })
      )
    )
  );

  const failed = results.filter((r) => !r.ok);
  assert.deepStrictEqual(failed.map((f) => f.message), [], 'a concurrent prepare failed');

  // NOT `new Set(cwds).size === N`: cwd is path.join(root, 'worktrees', orderId),
  // a pure function of the id, so distinct ids give distinct cwds by string
  // construction and that assertion can never fail. Ask git instead - it is the
  // one that has to survive the race.
  for (const r of results) {
    assert.ok(fs.existsSync(path.join(r.wt.cwd, 'file.txt')), `${r.wt.cwd} has no repo content`);
  }
  const listed = execSync('git worktree list --porcelain', { cwd: repo, encoding: 'utf8' })
    .split('\n').filter((l) => l.startsWith('worktree ')).length;
  assert.strictEqual(listed, N + 1, `git registered ${listed} worktrees, expected the main tree plus ${N}`);

  for (const r of results) await worktrees.cleanup(r.wt);
});

test('the mutex is per repo, not global', async () => {
  // A global lock would serialise unrelated projects, turning an isolation fix
  // into a throughput bug.
  //
  // Asserting that both prepares COMPLETE would not pin this: a global lock
  // completes both too, just serially. So make one repo's add genuinely slow -
  // a wrapper around git that sleeps after `worktree add` in a repo carrying a
  // marker (a sleeping post-checkout hook did this before SkillSpace stopped
  // running hooks) - start it first, and let it get inside its add before the
  // other begins. The fast repo must then finish FIRST. Under a global lock it
  // cannot: it would be chained behind a holder that sleeps for a second.
  const root = tmpDir('skillspace-wthome-');
  const slowRepo = tmpGitRepo();
  const fastRepo = tmpGitRepo();
  fs.writeFileSync(path.join(slowRepo, '.git', 'SLOW'), '');

  const finished = [];
  let slow, fast;
  await withGitWrapper('    [ -f "$(pwd)/.git/SLOW" ] && sleep 1', async () => {
    slow = worktrees.prepare(root, { kind: 'git', path: slowRepo }, 'ord_repo_slow')
      .then((wt) => { finished.push('slow'); return wt; });
    // Long enough that `slow` is past its read-only inspection and inside the
    // add (one rev-parse, tens of ms), short enough that its 1s sleep is still
    // running. Without this the two race for the lock and a global lock could
    // pass by luck.
    await sleep(250);
    fast = worktrees.prepare(root, { kind: 'git', path: fastRepo }, 'ord_repo_fast')
      .then((wt) => { finished.push('fast'); return wt; });
    await Promise.all([slow, fast]);
  });

  const [ws, wf] = await Promise.all([slow, fast]);

  assert.deepStrictEqual(
    finished, ['fast', 'slow'],
    'the fast repo waited behind an unrelated slow repo: the lock is global, not per repo'
  );
  assert.notStrictEqual(ws.cwd, wf.cwd);

  await worktrees.cleanup(ws);
  await worktrees.cleanup(wf);
});

test('discard removes a clean scratch worktree and its branch', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const wt = await worktrees.prepare(root, project, 'vrd-scratch-1');
  const { warning } = await worktrees.discard(wt);
  assert.strictEqual(warning, null);
  assert.ok(!fs.existsSync(wt.cwd));
  assert.strictEqual(execSync(`git branch --list ${wt.branch}`, { cwd: repo }).toString().trim(), '',
    'a scratch branch is pollution in the user repo');
});

test('discard keeps the branch of a scratch agent that wrote files, and says so', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const wt = await worktrees.prepare(root, project, 'vrd-scratch-2');
  fs.writeFileSync(path.join(wt.cwd, 'oops.txt'), 'told not to\n');
  const { warning } = await worktrees.discard(wt);
  assert.match(warning, /modified files despite being told not to/);
  assert.notStrictEqual(execSync(`git branch --list ${wt.branch}`, { cwd: repo }).toString().trim(), '');
});

test('branchFor names the branch prepare creates', async () => {
  const root = tmpDir('skillspace-home-');
  const project = projects.create(root, { path: tmpGitRepo() });
  const wt = await worktrees.prepare(root, project, 'ord-branchfor');
  assert.strictEqual(wt.branch, worktrees.branchFor('ord-branchfor'));
  await worktrees.cleanup(wt);
});

// ---------- SkillSpace's own git runs inside agent-writable trees ----------
// An agent can write the repository's config, its hooks, the worktree's
// .gitattributes and the worktree's .git pointer. SkillSpace then runs git
// there itself - status, add -A, commit, worktree remove - with whatever
// environment it has. Each test below plants one way of turning that git into
// "run my command", AFTER prepare (that is, as the agent), and asserts the
// command never ran and the work was still preserved.

function canaryScript(dir, name) {
  const canary = path.join(dir, name);
  const script = path.join(dir, name + '.sh');
  // Records which git ran it, so a failure names the command.
  fs.writeFileSync(script, `#!/bin/sh\nps -o args= -p $PPID >> "${canary}"\ncat\n`, { mode: 0o755 });
  return { canary, script };
}

test('a core.fsmonitor the agent planted does not run during cleanup', async () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const outside = tmpDir('skillspace-canary-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord_fsmon');
  const { canary, script } = canaryScript(outside, 'fsmonitor');
  // The agent: the common config is shared by every worktree of the repo.
  execSync(`git config core.fsmonitor "${script}"`, { cwd: wt.cwd });
  fs.writeFileSync(path.join(wt.cwd, 'agent-output.txt'), 'work\n');

  const r = await worktrees.cleanup(wt);
  assert.ok(!fs.existsSync(canary), 'SkillSpace ran the fsmonitor the agent planted');
  assert.strictEqual(r.committed, true, String(r.preserveError));
});

test('hooks the agent planted - by hooksPath or in the hooks dir - do not run during cleanup', async () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const outside = tmpDir('skillspace-canary-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord_hooks');
  // --no-verify skips pre-commit and commit-msg only; these two still run.
  const hooks = path.join(outside, 'hooks');
  fs.mkdirSync(hooks);
  for (const h of ['prepare-commit-msg', 'post-commit', 'post-checkout', 'reference-transaction']) {
    fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\ntouch "${path.join(outside, 'HOOK-' + h)}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(repo, '.git', 'hooks', h), `#!/bin/sh\ntouch "${path.join(outside, 'GITDIR-' + h)}"\n`, { mode: 0o755 });
  }
  execSync(`git config core.hooksPath "${hooks}"`, { cwd: wt.cwd });
  fs.writeFileSync(path.join(wt.cwd, 'agent-output.txt'), 'work\n');

  const r = await worktrees.cleanup(wt);
  assert.deepStrictEqual(fs.readdirSync(outside).filter((f) => f !== 'hooks'), [],
    'SkillSpace ran a hook during its own snapshot');
  assert.strictEqual(r.committed, true, String(r.preserveError));
});

test('a clean filter the agent planted does not run, and the work is committed as written', async () => {
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  const outside = tmpDir('skillspace-canary-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord_filter');
  const clean = canaryScript(outside, 'clean');
  const proc = canaryScript(outside, 'process');
  fs.writeFileSync(path.join(wt.cwd, '.gitattributes'), '* filter=evil\n');
  execSync(`git config filter.evil.clean "${clean.script}"`, { cwd: wt.cwd });
  execSync(`git config filter.evil.process "${proc.script}"`, { cwd: wt.cwd });
  execSync('git config filter.evil.required true', { cwd: wt.cwd });
  fs.writeFileSync(path.join(wt.cwd, 'agent-output.txt'), 'work\n');

  const r = await worktrees.cleanup(wt);
  const ran = (c) => (fs.existsSync(c) ? fs.readFileSync(c, 'utf8') : '');
  assert.strictEqual(ran(clean.canary), '', 'SkillSpace ran the clean filter the agent planted');
  assert.strictEqual(ran(proc.canary), '', 'SkillSpace ran the filter process the agent planted');
  assert.strictEqual(r.committed, true, String(r.preserveError));
  const body = execSync(`git show ${wt.branch}:agent-output.txt`, { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(body, 'work\n');
});

test('a rewritten .git pointer cannot redirect the snapshot into another repository', async () => {
  // The worktree's .git is a FILE the agent can rewrite. Followed, it would
  // send SkillSpace's add/commit - and that repo's config, hooks included - to
  // a repository of the agent's choosing. The gitdir comes from SkillSpace's
  // own record of the worktree instead.
  const repo = tmpGitRepo();
  const decoy = tmpGitRepo();
  const outside = tmpDir('skillspace-canary-');
  const root = tmpDir('skillspace-wthome-');
  const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord_pointer');
  fs.writeFileSync(path.join(decoy, '.git', 'hooks', 'post-commit'),
    `#!/bin/sh\ntouch "${path.join(outside, 'DECOY-HOOK')}"\n`, { mode: 0o755 });
  const decoyHead = execSync('git rev-parse HEAD', { cwd: decoy, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(wt.cwd, '.git'), `gitdir: ${path.join(decoy, '.git')}\n`);
  fs.writeFileSync(path.join(wt.cwd, 'agent-output.txt'), 'work\n');

  const r = await worktrees.cleanup(wt);
  assert.strictEqual(execSync('git rev-parse HEAD', { cwd: decoy, encoding: 'utf8' }).trim(), decoyHead,
    'the snapshot was committed into the repository the pointer named');
  assert.deepStrictEqual(fs.readdirSync(outside), [], 'the decoy repository\'s hook ran');
  assert.strictEqual(r.committed, true, String(r.preserveError));
  const files = execSync(`git ls-tree -r --name-only ${wt.branch}`, { cwd: repo, encoding: 'utf8' });
  assert.match(files, /agent-output\.txt/, 'the work did not land on the order branch');
});

test('SkillSpace\'s git gets a minimal environment, not every token the server holds', async () => {
  // A wrapper ahead of the real git on PATH records the environment each
  // invocation receives.
  const realGit = execSync('command -v git', { encoding: 'utf8' }).trim();
  const bin = tmpDir('skillspace-gitwrap-');
  const dumps = tmpDir('skillspace-gitenv-');
  fs.writeFileSync(path.join(bin, 'git'),
    `#!/bin/sh\nenv > "${dumps}/$$.env"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY };
  const repo = tmpGitRepo();
  const root = tmpDir('skillspace-wthome-');
  try {
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.AWS_SECRET_ACCESS_KEY = 'leak-me-not';
    const wt = await worktrees.prepare(root, { kind: 'git', path: repo }, 'ord_envmin');
    fs.writeFileSync(path.join(wt.cwd, 'agent-output.txt'), 'work\n');
    await worktrees.cleanup(wt);
    projects.detectKind(repo);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.AWS_SECRET_ACCESS_KEY === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = saved.AWS_SECRET_ACCESS_KEY;
  }
  const envs = fs.readdirSync(dumps).map((f) => fs.readFileSync(path.join(dumps, f), 'utf8'));
  assert.ok(envs.length >= 5, `expected every git call to go through the wrapper, saw ${envs.length}`);
  for (const e of envs) {
    assert.ok(!e.includes('leak-me-not'), 'a git invocation received the server\'s AWS token');
    assert.match(e, /^GIT_CONFIG_NOSYSTEM=1$/m);
    assert.match(e, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
  }
});
