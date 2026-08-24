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

test('a relative path is resolved to absolute, so kind cannot drift with the cwd', () => {
  const root = tmpRoot();
  const repo = tmpGitRepo();
  const cwd = process.cwd();
  let p;
  try {
    process.chdir(repo);
    p = projects.create(root, { path: '.' });
  } finally {
    process.chdir(cwd);
  }
  assert.strictEqual(p.path, fs.realpathSync(repo));
  assert.ok(path.isAbsolute(p.path));
  assert.notStrictEqual(p.name, '.');
  // the stored path must still be the git repo from any cwd
  assert.strictEqual(projects.detectKind(projects.get(root, p.id).path), 'git');
});

test('ids do not collide', () => {
  const ids = new Set();
  for (let i = 0; i < 50000; i++) ids.add(projects.newId());
  assert.strictEqual(ids.size, 50000);
});

test('concurrency is coerced to a sane positive integer', () => {
  const root = tmpRoot();
  const mk = (c) => projects.create(root, { path: tmpGitRepo(), concurrency: c }).concurrency;
  assert.strictEqual(mk(0), 2);
  assert.strictEqual(mk(-5), 2);
  assert.strictEqual(mk('8'), 8);
  assert.strictEqual(mk(1.5), 1);
  assert.strictEqual(mk(9999), 8);
  assert.strictEqual(mk({}), 2);
  assert.strictEqual(mk(undefined), 2);
});

test('a dir project stays at 1 whatever is passed', () => {
  const root = tmpRoot();
  for (const c of [8, '99', -1, {}]) {
    assert.strictEqual(projects.create(root, { path: tmpDir(), concurrency: c }).concurrency, 1);
  }
});

test('budget rejects unknown keys and out-of-range values', () => {
  const root = tmpRoot();
  const p = projects.create(root, {
    path: tmpDir(),
    budget: { orderTimeoutMs: 0, maxOrdersPerDay: -1, maxOrdersPerGoal: 'lots', injected: 'extra' },
  });
  assert.strictEqual(p.budget.orderTimeoutMs, 900000);
  assert.strictEqual(p.budget.maxOrdersPerDay, 100);
  assert.strictEqual(p.budget.maxOrdersPerGoal, 12);
  assert.strictEqual(p.budget.injected, undefined);
  assert.deepStrictEqual(Object.keys(p.budget).sort(), Object.keys(projects.DEFAULT_BUDGET).sort());
});

test('a valid budget override is honoured', () => {
  const root = tmpRoot();
  const p = projects.create(root, { path: tmpDir(), budget: { maxOrdersPerGoal: 5 } });
  assert.strictEqual(p.budget.maxOrdersPerGoal, 5);
  assert.strictEqual(p.budget.maxOrdersPerDay, 100);
});

test('a directory with a junk .git file is not treated as a repository', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, '.git'), 'gitdir: /nowhere/that/exists');
  assert.strictEqual(projects.detectKind(d), 'dir');
});

test('a subdirectory of a repo is not a repo root', () => {
  const repo = tmpGitRepo();
  const sub = path.join(repo, 'src');
  fs.mkdirSync(sub);
  assert.strictEqual(projects.detectKind(sub), 'dir');
});

test('a linked git worktree is still git', () => {
  const repo = tmpGitRepo();
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: repo });
  const wt = path.join(tmpDir(), 'wt');
  execSync(`git worktree add -q -b probe "${wt}"`, { cwd: repo });
  assert.strictEqual(projects.detectKind(wt), 'git');
});

test('remove reports whether a record actually matched', () => {
  const root = tmpRoot();
  const p = projects.create(root, { path: tmpDir() });
  assert.strictEqual(projects.remove(root, 'prj-nope'), false);
  assert.strictEqual(projects.list(root).length, 1);
  assert.strictEqual(projects.remove(root, p.id), true);
  assert.strictEqual(projects.list(root).length, 0);
});

test('kind is detected, never taken from the caller', () => {
  const root = tmpRoot();
  // A caller claiming git on a plain directory must not get git — kind decides
  // whether agents can be isolated, so an attacker-or-typo-supplied value would
  // put several agents over one working tree.
  const p = projects.create(root, { path: tmpDir(), kind: 'git', concurrency: 8 });
  assert.strictEqual(p.kind, 'dir');
  assert.strictEqual(p.concurrency, 1);
  // and the reverse direction: claiming dir on a real repo must not downgrade it
  const g = projects.create(root, { path: tmpGitRepo(), kind: 'dir' });
  assert.strictEqual(g.kind, 'git');
});

test('a subdirectory carrying a .git entry is still not a repo root', () => {
  // The plain-subdirectory test cannot reach the toplevel comparison: with no
  // .git present, existsSync short-circuits first. This shape does reach it —
  // rev-parse succeeds from here, and only the toplevel equality check catches
  // that this is not the root.
  const repo = tmpGitRepo();
  const sub = path.join(repo, 'b');
  fs.mkdirSync(path.join(sub, '.git'), { recursive: true });
  assert.strictEqual(projects.detectKind(sub), 'dir');
});

test('creating a second project keeps the first', () => {
  const root = tmpRoot();
  const a = projects.create(root, { name: 'First', path: tmpDir() });
  const b = projects.create(root, { name: 'Second', path: tmpDir() });
  const all = projects.list(root);
  assert.strictEqual(all.length, 2);
  assert.deepStrictEqual(all.map((p) => p.name), ['First', 'Second']);
  assert.ok(projects.get(root, a.id));
  assert.ok(projects.get(root, b.id));
});

test('a project carries the full record shape', () => {
  const root = tmpRoot();
  const p = projects.create(root, { name: 'Shape', path: tmpDir() });
  assert.deepStrictEqual(Object.keys(p).sort(), [
    'agents', 'branch', 'budget', 'concurrency', 'createdAt',
    'id', 'kind', 'name', 'path', 'skillSources',
  ]);
  assert.strictEqual(p.branch, null);
  assert.deepStrictEqual(p.skillSources, []);
  assert.deepStrictEqual(p.agents, []);
  assert.ok(!Number.isNaN(Date.parse(p.createdAt)), 'createdAt must be a parseable timestamp');
});

test('a budget override cannot poison the defaults for later projects', () => {
  const root = tmpRoot();
  projects.create(root, { path: tmpDir(), budget: { maxOrdersPerGoal: 5 } });
  // the module's own defaults must be untouched...
  assert.strictEqual(projects.DEFAULT_BUDGET.maxOrdersPerGoal, 12);
  // ...and a project created afterwards must still get them
  const later = projects.create(root, { path: tmpDir() });
  assert.strictEqual(later.budget.maxOrdersPerGoal, 12);
});

test('caller-supplied fields with impossible types do not reach disk', () => {
  const root = tmpRoot();
  const p = projects.create(root, {
    path: tmpDir(),
    name: { evil: 1 },
    branch: 42,
    skillSources: 7,
    agents: 'not-an-array',
  });
  assert.strictEqual(typeof p.name, 'string');
  assert.notDeepStrictEqual(p.name, { evil: 1 });
  assert.strictEqual(p.branch, null);
  assert.deepStrictEqual(p.skillSources, []);
  assert.deepStrictEqual(p.agents, []);
  // and it survives the round-trip that way
  assert.deepStrictEqual(projects.get(root, p.id).agents, []);
});

test('a mixed array keeps only the usable strings', () => {
  const root = tmpRoot();
  const p = projects.create(root, { path: tmpDir(), agents: ['claude', 42, null, 'opencode', ''] });
  assert.deepStrictEqual(p.agents, ['claude', 'opencode']);
});

test('an overlong name is truncated rather than stored whole', () => {
  const root = tmpRoot();
  const p = projects.create(root, { path: tmpDir(), name: 'x'.repeat(100000) });
  assert.strictEqual(p.name.length, 200);
});

test('budget values are bounded above as well as below', () => {
  const root = tmpRoot();
  const p = projects.create(root, {
    path: tmpDir(),
    budget: { orderTimeoutMs: 1e15, maxOrdersPerGoal: 1e300, maxOrdersPerDay: 9e15 },
  });
  assert.strictEqual(p.budget.orderTimeoutMs, 24 * 60 * 60 * 1000);
  assert.strictEqual(p.budget.maxOrdersPerGoal, 500);
  assert.strictEqual(p.budget.maxOrdersPerDay, 10000);
});

test('a non-string path is the callers error, not a TypeError', () => {
  const root = tmpRoot();
  for (const bad of [123, [], {}, true]) {
    assert.throws(() => projects.create(root, { path: bad }), /path does not exist/);
  }
  assert.throws(() => projects.create(root, null), /path does not exist/);
  assert.throws(() => projects.create(root, undefined), /path does not exist/);
});

test('a symlink and its target resolve to the same stored path', () => {
  const root = tmpRoot();
  const repo = tmpGitRepo();
  const link = path.join(tmpDir(), 'link');
  fs.symlinkSync(repo, link);
  const a = projects.create(root, { path: repo });
  const b = projects.create(root, { path: link });
  assert.strictEqual(a.path, b.path);
});

test('the default name is the directory basename', () => {
  const root = tmpRoot();
  const dir = tmpDir();
  assert.strictEqual(projects.create(root, { path: dir }).name, path.basename(dir));
});

test('get returns null for an unknown id, never undefined', () => {
  const root = tmpRoot();
  projects.create(root, { path: tmpDir() });
  assert.strictEqual(projects.get(root, 'prj-nope'), null);
});

test('get re-detects kind, so a repo that stopped being one loses its concurrency', () => {
  // kind is detected once at create() and stored. If the tree stops being a
  // repository afterwards - deleted and re-cloned in place, absorbed as a
  // subdirectory of a parent repo, `git worktree remove` - the record still
  // says git and still carries concurrency 2. That is several agents over a
  // tree with no isolation mechanism, which is the exact corruption kind
  // exists to prevent.
  const root = tmpRoot();
  const repo = tmpGitRepo();
  const p = projects.create(root, { path: repo });
  assert.strictEqual(p.kind, 'git');
  assert.strictEqual(p.concurrency, 2);

  fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });

  const fresh = projects.get(root, p.id);
  assert.strictEqual(fresh.kind, 'dir', 'get must not report a stale git');
  assert.strictEqual(fresh.concurrency, 1, 'a dir has no isolation and cannot run 2 agents');
  // list() is the cheap UI path and stays as-stored; get() is what a scheduler
  // reads before granting concurrency, so that is where truth has to be fresh.
  assert.strictEqual(projects.list(root)[0].kind, 'git');
});

test('get leaves an unchanged project exactly as stored', () => {
  const root = tmpRoot();
  const repo = tmpGitRepo();
  const p = projects.create(root, { path: repo });
  assert.deepStrictEqual(projects.get(root, p.id), p);

  const d = projects.create(root, { path: tmpDir() });
  assert.deepStrictEqual(projects.get(root, d.id), d);
});

test('get does not raise concurrency when a plain dir becomes a repo', () => {
  // The safe direction: gaining a .git does not retroactively grant the record
  // an explicit concurrency it was never given. It gets the git default, not
  // some remembered higher number.
  const root = tmpRoot();
  const dir = tmpDir();
  const p = projects.create(root, { path: dir, concurrency: 8 });
  assert.strictEqual(p.concurrency, 1);

  execSync('git init -q', { cwd: dir });

  const fresh = projects.get(root, p.id);
  assert.strictEqual(fresh.kind, 'git');
  assert.strictEqual(fresh.concurrency, 2);
});

test('a directory vanishing mid-create is still the callers path error', () => {
  const root = tmpRoot();
  // Both filesystem calls between the existence check and the record must be
  // covered: wrapping only statSync moved the raw ENOENT down one statement
  // rather than removing it. The monkeypatch is process-global and is safe
  // only because create() is fully synchronous - the same constraint the store
  // suite documents. Do not introduce an await inside the try.
  for (const fn of ['statSync', 'realpathSync']) {
    const dir = tmpDir();
    const real = fs[fn];
    fs[fn] = (p, ...rest) => {
      if (path.resolve(p) === path.resolve(dir)) {
        const e = new Error(`ENOENT: no such file or directory, ${fn} '${p}'`);
        e.code = 'ENOENT';
        throw e;
      }
      return real(p, ...rest);
    };
    try {
      assert.throws(() => projects.create(root, { path: dir }), /path does not exist/, `via ${fn}`);
    } finally {
      fs[fn] = real;
    }
  }
});

test('an ambient GIT_WORK_TREE cannot flip a junk .git into a repo', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, '.git'), 'gitdir: /nowhere/that/exists');
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(tmpGitRepo(), '.git');
  process.env.GIT_WORK_TREE = d;
  try {
    // the probe must not inherit the ambient override — launching the server
    // from inside a git hook or `git rebase --exec` is enough to set these
    assert.strictEqual(projects.detectKind(d), 'dir');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
