# Orders That Run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a registered project the thing an agent actually works on — a durable work order that runs in an isolated git worktree, with its output logged, its exit recorded, and its runtime bounded.

**Architecture:** Three new modules under `lib/`, each with one responsibility: `orders.js` persists the order record and its lifecycle, `worktrees.js` prepares and removes the isolated `cwd`, and `runner.js` owns spawning an agent and recording what happened. `server.js` gains routes only and — importantly — **loses** ~90 lines, because the existing `/api/run` spawn block moves into `runner.js` and both paths then share it.

**Tech Stack:** Plain Node 24, zero runtime dependencies, `node:test`, no framework, no build step. Builds on Plan 1's `lib/store.js` (atomic JSON, path-guarded) and `lib/projects.js`.

---

## Scope of this plan

The design's Plan 2 (`§3 Goal/Order, §4 flow, §5 isolation, §8a budget, scheduler`) is seven subsystems. Plan 1 was four tasks and took 29 commits across eight review cycles; the same density here would be unreviewable. So Plan 2 splits, and **this document is Plan 2a**:

| | Scope | Ships |
|---|---|---|
| **2a — this plan** | §3 Order, §5 isolation, §8a `orderTimeoutMs` + `maxOrdersPerDay`, §10 error handling, runner extraction | POST a prompt against a project → it runs in an isolated worktree → log and exit code persisted → visible via API |
| **2b — next** | §3 Goal, §4 PM decomposition + verdicts, §8a `maxOrdersPerGoal`, the scheduler loop | State a goal → PM fans it into orders → scheduler runs up to `concurrency` → PM issues verdicts |
| **3** | §8 board + order drawer, live log streaming | Watch it happen |

2a ships alone: "run this prompt against this project, safely isolated, with a bounded runtime and a durable record" is useful without a PM, and it is the thing 2b's scheduler will call.

**Explicitly out of scope here, deferred to 2b:** `Goal`, `goalId` (orders carry `goalId: null`), `verdict`, `supersedes`, `acceptance` (stored but never judged), and the scheduler loop. Orders in 2a are dispatched one at a time by the route that creates them.

## File structure

| File | Responsibility | Approx |
|---|---|---|
| `lib/orders.js` | Order shape, lifecycle transitions, CRUD on `store`, day-count for `maxOrdersPerDay`, boot reconciliation. Knows nothing about git or spawning. | 170 |
| `lib/worktrees.js` | Prepare an isolated `cwd` for an order and remove it. Knows git; knows nothing about orders' persistence. | 120 |
| `lib/runner.js` | Spawn an agent, stream to a log file, enforce the timeout, reap the process group, report the outcome. Knows nothing about git or orders. | 170 |
| `test/orders.test.js` | Lifecycle, persistence, day-count, reconciliation. | 200 |
| `test/worktrees.test.js` | Isolation, branch validation, failure leaves nothing behind. | 150 |
| `test/runner.test.js` | Exit codes, timeout, cancel, log capture. Uses shims — never a real agent. | 170 |
| `server.js` | Order routes; the `/api/run` spawn block is **deleted** and delegated to `runner.js`. | +70 / −90 |

`server.js` is 1066 lines and `public/app.js` is 949 — both past this project's 800-line ceiling. Every new decision in this plan lands in `lib/`, and Task 5 makes `server.js` smaller than it started.

### Why three modules and not one

`runner.js` must be testable without git, and `worktrees.js` must be testable without spawning an agent. Fusing them would mean every runner test needs a repo and every worktree test needs a shim. They also fail differently and at different times: a worktree failure must abort *before* any agent starts (spec §10), which is only expressible if preparing the cwd is a separate step the caller can fail on.

---

## Task 1: Order model and lifecycle

**Files:**
- Create: `lib/orders.js`
- Test: `test/orders.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/orders.test.js`:

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const orders = require('../lib/orders');

const created = [];
function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-orders-'));
  created.push(d);
  return d;
}
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

test('create stores an order and returns it queued', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'prj-1', prompt: 'do the thing' });
  assert.ok(o.id.startsWith('ord-'));
  assert.strictEqual(o.status, 'queued');
  assert.strictEqual(o.projectId, 'prj-1');
  assert.strictEqual(o.prompt, 'do the thing');
  assert.strictEqual(o.goalId, null, 'goalId is reserved for plan 2b');
  assert.strictEqual(o.exitCode, null);
  assert.strictEqual(o.verdict, null);
  assert.ok(!Number.isNaN(Date.parse(o.createdAt)));
});

test('create requires a projectId and a prompt', () => {
  const root = tmpRoot();
  assert.throws(() => orders.create(root, { prompt: 'x' }), /projectId is required/);
  assert.throws(() => orders.create(root, { projectId: 'p' }), /prompt is required/);
  assert.throws(() => orders.create(root, { projectId: 'p', prompt: '   ' }), /prompt is required/);
});

test('an order round-trips through the store', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'prj-1', prompt: 'p' });
  assert.deepStrictEqual(orders.get(root, o.id), o);
});

test('get returns null for an unknown id, never undefined', () => {
  assert.strictEqual(orders.get(tmpRoot(), 'ord-nope'), null);
});

test('list returns every order, newest first', () => {
  const root = tmpRoot();
  const a = orders.create(root, { projectId: 'p', prompt: '1' });
  const b = orders.create(root, { projectId: 'p', prompt: '2' });
  const all = orders.list(root);
  assert.strictEqual(all.length, 2);
  assert.deepStrictEqual(all.map((o) => o.id), [b.id, a.id]);
});

test('list filters by project', () => {
  const root = tmpRoot();
  orders.create(root, { projectId: 'p1', prompt: 'x' });
  orders.create(root, { projectId: 'p2', prompt: 'y' });
  assert.strictEqual(orders.list(root, { projectId: 'p1' }).length, 1);
});

test('the lifecycle advances queued -> running -> succeeded', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  const started = orders.markRunning(root, o.id, { cwd: '/tmp/wt', agent: 'claude' });
  assert.strictEqual(started.status, 'running');
  assert.strictEqual(started.cwd, '/tmp/wt');
  assert.strictEqual(started.agent, 'claude');
  assert.ok(!Number.isNaN(Date.parse(started.startedAt)));

  const done = orders.markFinished(root, o.id, { exitCode: 0 });
  assert.strictEqual(done.status, 'succeeded');
  assert.strictEqual(done.exitCode, 0);
  assert.ok(!Number.isNaN(Date.parse(done.finishedAt)));
});

test('a non-zero exit is failed, not succeeded', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  orders.markRunning(root, o.id, { cwd: '/tmp/wt', agent: 'claude' });
  const done = orders.markFinished(root, o.id, { exitCode: 3 });
  assert.strictEqual(done.status, 'failed');
  assert.strictEqual(done.exitCode, 3);
});

test('a timeout is failed with error "timeout", distinct from a non-zero exit', () => {
  // Spec §8a: the two mean different things and must not be collapsed. A
  // reader of the board has to be able to tell "the agent gave up" from "we
  // stopped it".
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  orders.markRunning(root, o.id, { cwd: '/tmp/wt', agent: 'claude' });
  const done = orders.markFinished(root, o.id, { error: 'timeout' });
  assert.strictEqual(done.status, 'failed');
  assert.strictEqual(done.error, 'timeout');
  assert.strictEqual(done.exitCode, null, 'a killed process has no exit code of its own');
});

test('markFailed records a failure that happened before any agent started', () => {
  // Spec §10: a worktree that cannot be created fails the order before a spawn.
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  const done = orders.markFailed(root, o.id, 'worktree: dirty tree');
  assert.strictEqual(done.status, 'failed');
  assert.match(done.error, /dirty tree/);
  assert.strictEqual(done.startedAt, null, 'nothing ever started');
});

test('cancel is its own status, not a failure', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  orders.markRunning(root, o.id, { cwd: '/tmp/wt', agent: 'claude' });
  assert.strictEqual(orders.markCancelled(root, o.id).status, 'cancelled');
});

test('a finished order cannot be moved again', () => {
  // Without this, a late close event from a process we already timed out would
  // rewrite the record and erase why it actually ended.
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  orders.markRunning(root, o.id, { cwd: '/tmp/wt', agent: 'claude' });
  orders.markFinished(root, o.id, { error: 'timeout' });
  const again = orders.markFinished(root, o.id, { exitCode: 0 });
  assert.strictEqual(again.status, 'failed', 'a settled order must stay settled');
  assert.strictEqual(again.error, 'timeout');
});

test('countToday counts only today and only this project', () => {
  const root = tmpRoot();
  const a = orders.create(root, { projectId: 'p1', prompt: 'x' });
  orders.create(root, { projectId: 'p2', prompt: 'y' });
  // Backdate one by writing the record directly, the way a previous day's run
  // would look on disk after a restart.
  const old = { ...orders.get(root, a.id), createdAt: '2020-01-01T00:00:00.000Z' };
  require('../lib/store').writeJson(root, `orders/${a.id}.json`, old);
  assert.strictEqual(orders.countToday(root, 'p1'), 0);
  assert.strictEqual(orders.countToday(root, 'p2'), 1);
});

test('reconcile marks orphaned running orders interrupted', () => {
  // Spec §10: on boot a running order's child process is gone. It is never
  // assumed to have succeeded.
  const root = tmpRoot();
  const a = orders.create(root, { projectId: 'p', prompt: 'x' });
  const b = orders.create(root, { projectId: 'p', prompt: 'y' });
  orders.markRunning(root, a.id, { cwd: '/tmp/wt', agent: 'claude' });
  orders.markFinished(root, b.id, { exitCode: 0 });

  const n = orders.reconcile(root);
  assert.strictEqual(n, 1, 'exactly one order was running');
  assert.strictEqual(orders.get(root, a.id).status, 'interrupted');
  assert.strictEqual(orders.get(root, a.id).error, 'interrupted');
  assert.strictEqual(orders.get(root, b.id).status, 'succeeded', 'settled orders are untouched');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'test/orders.test.js'`

Expected: FAIL with `Cannot find module '../lib/orders'`.

**Node 24 requires the quoted glob** — `node --test test/` fails, because Node ≥23 treats positional arguments as file paths and `test/` resolves as a module.

- [ ] **Step 3: Write the implementation**

Create `lib/orders.js`:

```js
'use strict';
const crypto = require('crypto');
const store = require('./store');

// A work order is the unit an agent executes and the unit the board watches.
// This module owns the record and its lifecycle only: it knows nothing about
// git, nothing about spawning, and never touches a filesystem outside `root`.
//
// Known limits:
// - goalId, acceptance, verdict and supersedes are stored but never read here.
//   They belong to the PM flow in plan 2b; the fields exist now so the record
//   shape does not change under an already-persisted store.
// - Same cross-process race as lib/projects: each order is its own file, so
//   two writers collide only on the same order, not on the whole collection.
//   That is strictly better than projects.json but still unlocked.

const SUB = 'orders';
const MAX_TEXT = 100000; // a prompt carrying an injected Skill body is large

// Terminal states. A settled order is never rewritten: a late close event from
// a process we already timed out would otherwise erase why it really ended.
const SETTLED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

function newId() {
  return 'ord-' + crypto.randomUUID();
}

function rel(id) {
  return `${SUB}/${id}.json`;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim().slice(0, MAX_TEXT);
}

function create(root, input) {
  const src = input && typeof input === 'object' ? input : {};
  const projectId = text(src.projectId, 'projectId');
  const prompt = text(src.prompt, 'prompt');

  const order = {
    id: newId(),
    projectId,
    goalId: null,          // plan 2b
    seq: null,             // plan 2b
    title: typeof src.title === 'string' ? src.title.trim().slice(0, 200) : '',
    prompt,
    acceptance: typeof src.acceptance === 'string' ? src.acceptance.slice(0, MAX_TEXT) : '',
    agent: null,
    cwd: null,
    status: 'queued',
    exitCode: null,
    verdict: null,         // plan 2b
    error: null,
    supersedes: null,      // plan 2b
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
  store.writeJson(root, rel(order.id), order);
  return order;
}

function get(root, id) {
  return store.readJson(root, rel(id), null);
}

function list(root, filter) {
  const f = filter || {};
  const all = store
    .list(root, SUB)
    .map((id) => get(root, id))
    .filter(Boolean);
  const picked = f.projectId ? all.filter((o) => o.projectId === f.projectId) : all;
  // Newest first: the board reads top-down and the newest order is the one a
  // human just created. store.list() sorts lexicographically by id, which for
  // a UUID is arbitrary.
  return picked.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Every transition goes through here so the settled-state rule cannot be
// forgotten at one call site.
function patch(root, id, changes) {
  const o = get(root, id);
  if (!o) return null;
  if (SETTLED.has(o.status)) return o;
  const next = { ...o, ...changes };
  store.writeJson(root, rel(id), next);
  return next;
}

function markRunning(root, id, { cwd, agent }) {
  return patch(root, id, {
    status: 'running',
    cwd: cwd || null,
    agent: agent || null,
    startedAt: new Date().toISOString(),
  });
}

// exitCode 0 is the ONLY success. Note this records that the process exited
// zero, not that it did the right thing - that judgement is the PM verdict in
// plan 2b, and collapsing the two is the most common multi-agent failure.
function markFinished(root, id, { exitCode = null, error = null }) {
  const timedOutOrKilled = error !== null;
  return patch(root, id, {
    status: !timedOutOrKilled && exitCode === 0 ? 'succeeded' : 'failed',
    exitCode: timedOutOrKilled ? null : exitCode,
    error,
    finishedAt: new Date().toISOString(),
  });
}

// A failure before anything started - a worktree that could not be created,
// an agent binary that is not installed. startedAt stays null so the board can
// tell "never ran" from "ran and failed".
function markFailed(root, id, error) {
  return patch(root, id, {
    status: 'failed',
    error: String(error),
    finishedAt: new Date().toISOString(),
  });
}

function markCancelled(root, id) {
  return patch(root, id, {
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
  });
}

// Counted from persisted records rather than an in-memory tally, so the limit
// survives a restart (spec §8a).
function countToday(root, projectId) {
  const today = new Date().toISOString().slice(0, 10);
  return list(root, { projectId }).filter((o) => o.createdAt.slice(0, 10) === today).length;
}

// On boot, any order still marked running lost its child process when the
// previous server died. It is never assumed to have succeeded (spec §10).
function reconcile(root) {
  let n = 0;
  for (const o of list(root)) {
    if (o.status !== 'running') continue;
    store.writeJson(root, rel(o.id), {
      ...o,
      status: 'interrupted',
      error: 'interrupted',
      finishedAt: new Date().toISOString(),
    });
    n++;
  }
  return n;
}

module.exports = {
  create, get, list, markRunning, markFinished, markFailed, markCancelled,
  countToday, reconcile, newId, SETTLED,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test 'test/orders.test.js'`

Expected: PASS — 14 tests, 0 failures.

Then run the whole suite to confirm nothing regressed: `node --test 'test/*.test.js'` → 115 passing (101 existing + 14).

- [ ] **Step 5: Mutation-verify the two rules that carry weight**

A passing suite has proven insufficient on this branch four times. For each mutant below, apply it, confirm the named test fails, restore, confirm it passes. Report both outputs.

```bash
# M1: settled orders become rewritable
#   In patch(), delete the line: if (SETTLED.has(o.status)) return o;
#   Expect: "a finished order cannot be moved again" FAILS
# M2: a timeout is recorded as a plain failure
#   In markFinished(), change  exitCode: timedOutOrKilled ? null : exitCode
#                        to    exitCode: exitCode
#   Expect: "a timeout is failed with error timeout" FAILS
# M3: reconcile touches settled orders
#   In reconcile(), change  if (o.status !== 'running') continue;
#                     to    if (o.status === 'interrupted') continue;
#   Expect: "reconcile marks orphaned running orders interrupted" FAILS
```

- [ ] **Step 6: Commit**

```bash
git add lib/orders.js test/orders.test.js
git commit -F- <<'EOF'
feat(orders): the work order record and its lifecycle

An order is the unit an agent executes and the unit the board watches. This is
the record and its transitions only - no git, no spawning, no filesystem
outside the store root.

Two rules are load-bearing and mutation-tested. A settled order is never
rewritten, because a late close event from a process we already timed out would
otherwise erase why it really ended. And a timeout is failed with
error: "timeout" and no exit code, distinct from an agent that exited non-zero
on its own - the two mean different things and the board has to tell them
apart.

goalId, acceptance, verdict and supersedes are stored but unread; they belong
to the PM flow in the next plan, and having the fields now means the record
shape does not change under an already-persisted store.
EOF
```

---

## Task 2: Isolated working directories

**Files:**
- Create: `lib/worktrees.js`
- Test: `test/worktrees.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/worktrees.test.js`:

```js
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
  // Spec §5: a plain directory has no isolation mechanism. It is serialised
  // rather than silently allowed to collide, and the caller must be able to
  // see which it got.
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
  // Spec §10: worktree creation failing must abort before any agent spawns and
  // must not leave a half-created directory.
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'test/worktrees.test.js'`

Expected: FAIL with `Cannot find module '../lib/worktrees'`.

- [ ] **Step 3: Write the implementation**

Create `lib/worktrees.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Prepares the directory an agent runs in. Two agents editing one working tree
// concurrently will corrupt each other, so a git project gets a real
// `git worktree` per order and a plain directory - which has no isolation
// mechanism at all - runs in place and is serialised by the caller instead.
//
// Knows git. Knows nothing about how orders are persisted or how agents are
// spawned, so it can be tested without either.
//
// Known cost, recorded rather than solved: a fresh worktree does not inherit
// node_modules. Projects needing install pay that per order (spec §5).

const GIT_TIMEOUT_MS = 30000;

// The id becomes both a directory name and a branch name.
const PLAIN_ID = /^[A-Za-z0-9_-]+$/;

// git check-ref-format's rules, reduced to what we actually need, plus the
// leading dash. A branch called "--force" would be read by git as a flag no
// matter how carefully the argv array is built, because git parses its own
// arguments after we hand them over.
function assertBranch(branch) {
  const ok =
    typeof branch === 'string' &&
    branch.length > 0 &&
    branch.length <= 200 &&
    !branch.startsWith('-') &&
    !branch.endsWith('.lock') &&
    !branch.endsWith('/') &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(branch);
  if (!ok) throw new Error(`invalid branch: ${String(branch)}`);
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    // Strip the ambient overrides for the same reason lib/projects does: a
    // GIT_DIR inherited from a hook would silently retarget the worktree.
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
  });
}

function worktreeDir(root, orderId) {
  return path.join(root, 'worktrees', orderId);
}

// Returns { cwd, isolated, branch }. `isolated: false` means the agent is
// editing the user's actual project directory, which the caller must surface
// rather than hide.
function prepare(root, project, orderId) {
  if (typeof orderId !== 'string' || !PLAIN_ID.test(orderId)) {
    throw new Error(`invalid order id: ${String(orderId)}`);
  }
  if (!project || typeof project.path !== 'string' || !project.path) {
    throw new Error('worktree: project has no path');
  }
  if (project.branch !== null && project.branch !== undefined) assertBranch(project.branch);

  if (project.kind !== 'git') {
    // No isolation available. The caller forces concurrency to 1 for these.
    return { cwd: project.path, isolated: false, branch: null };
  }

  const dest = worktreeDir(root, orderId);
  const branch = `skillspace/${orderId}`;
  assertBranch(branch);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    // -b creates a branch for this order so the worktree is detached from
    // whatever the user has checked out. `--` terminates option parsing.
    const base = project.branch ? [project.branch] : [];
    git(['worktree', 'add', '-b', branch, '--', dest, ...base], project.path);
  } catch (e) {
    // Spec §10: nothing half-created is left behind, and the order fails
    // before any agent spawns.
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
    try { git(['worktree', 'prune'], project.path); } catch (_) {}
    const detail = (e.stderr || e.message || '').toString().trim().split('\n')[0];
    throw new Error(`worktree: ${detail || 'could not create worktree'}`);
  }

  return { cwd: dest, isolated: true, branch, projectPath: project.path };
}

// Idempotent: a cancelled order and its own close handler may both call this.
function cleanup(root, wt) {
  if (!wt || !wt.isolated) return; // never remove a dir project's directory
  try {
    git(['worktree', 'remove', '--force', '--', wt.cwd], wt.projectPath);
  } catch (_) {
    // The worktree may already be gone, or the repo may have moved. Remove the
    // directory directly and let prune reconcile git's own bookkeeping.
    try { fs.rmSync(wt.cwd, { recursive: true, force: true }); } catch (__) {}
  }
  try { git(['worktree', 'prune'], wt.projectPath); } catch (_) {}
  if (wt.branch) {
    try { git(['branch', '-D', '--', wt.branch], wt.projectPath); } catch (_) {}
  }
}

module.exports = { prepare, cleanup, assertBranch, worktreeDir };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test 'test/worktrees.test.js'`

Expected: PASS — 8 tests, 0 failures.

Then: `node --test 'test/*.test.js'` → 123 passing.

- [ ] **Step 5: Mutation-verify isolation and the branch guard**

```bash
# M1: dir projects get "isolated" wrongly
#   In prepare(), change the dir return to { cwd: project.path, isolated: true, branch: null }
#   Expect: "a dir project runs in the project itself" FAILS
# M2: the leading-dash guard is removed
#   In assertBranch(), delete: !branch.startsWith('-') &&
#   Expect: "a branch name that could be read as a flag is refused" FAILS
# M3: cleanup removes a dir project's directory
#   In cleanup(), change  if (!wt || !wt.isolated) return;  to  if (!wt) return;
#   Expect: "a dir project runs in the project itself" FAILS on the existsSync assertion
# M4: failed prepare leaves the directory
#   In the catch block, delete the fs.rmSync line
#   Expect: "a failed prepare leaves nothing behind" FAILS
```

**M3 is the one to watch.** If it does not fail, the test is not proving that cleanup spares the user's project — fix the test, not the assertion.

- [ ] **Step 6: Confirm no worktrees or branches escape the temp dirs**

```bash
git worktree list
git branch --list 'skillspace/*'
```

Expected: only the repo's real worktrees, and **no** `skillspace/*` branches. Every fixture repo lives under `mktemp` and dies with it; a `skillspace/ord-*` branch appearing in this repo means a test used the wrong cwd.

- [ ] **Step 7: Commit**

```bash
git add lib/worktrees.js test/worktrees.test.js
git commit -F- <<'EOF'
feat(worktrees): an isolated working directory per order

Two agents editing one tree corrupt each other, so a git project gets a real
git worktree per order under the store root, on its own skillspace/<orderId>
branch. A plain directory has no isolation mechanism at all: it runs in place
and reports isolated: false, which the caller serialises on rather than hiding.

cleanup() is a no-op for a dir project. Removing that directory would delete
the user's own work, so the guard is mutation-tested rather than assumed.

This is the git worktree add call site that lib/projects deferred branch
validation to. A branch named "--force" is read as a flag by git no matter how
the argv array is built, because git parses its arguments after we hand them
over - so leading dashes, .lock suffixes, .., @{ and whitespace are all
refused here, where the argv is actually known.

A failed prepare removes the partial directory and prunes, so an order fails
before any agent spawns with nothing half-created left behind.
EOF
```

---

## Task 3: The agent runner

**Files:**
- Create: `lib/runner.js`
- Test: `test/runner.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/runner.test.js`:

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runner = require('../lib/runner');

const created = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'skillspace-run-'));
  created.push(d);
  return d;
}
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

// A fake agent, so no test ever spends money. It takes its behaviour from the
// prompt it is given, which is exactly how a real agent is invoked.
function shimAgent(script) {
  const dir = tmpDir('skillspace-shim-');
  const bin = path.join(dir, 'fake-agent');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return { id: 'fake', bin, buildArgs: (p) => ['-p', p] };
}

const ECHO = '#!/bin/sh\necho "stdout: $2"\necho "stderr line" >&2\nexit 0\n';
const FAIL = '#!/bin/sh\necho "going wrong"\nexit 7\n';
const SLOW = '#!/bin/sh\nsleep 60\n';
const CHILD = '#!/bin/sh\nsleep 60 &\nwait\n';

test('a successful run reports exit 0 and captures both streams', async () => {
  const cwd = tmpDir();
  const logFile = path.join(tmpDir(), 'run.log');
  const r = await runner.run({
    agent: shimAgent(ECHO), prompt: 'hello world', cwd, logFile, timeoutMs: 10000,
  });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.error, null);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /stdout: hello world/);
  assert.match(log, /stderr line/, 'stderr must be captured too — that is where agents explain failures');
});

test('a non-zero exit is reported, not thrown', async () => {
  const r = await runner.run({
    agent: shimAgent(FAIL), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 10000,
  });
  assert.strictEqual(r.exitCode, 7);
  assert.strictEqual(r.error, null, 'a non-zero exit is the agent failing, not the runner');
});

test('the agent runs in the cwd it is given', async () => {
  const cwd = tmpDir();
  const logFile = path.join(tmpDir(), 'run.log');
  await runner.run({
    agent: shimAgent('#!/bin/sh\npwd\nexit 0\n'), prompt: 'x', cwd, logFile, timeoutMs: 10000,
  });
  assert.match(fs.readFileSync(logFile, 'utf8'), new RegExp(fs.realpathSync(cwd)));
});

test('a run past its timeout is killed and reported as timeout', async () => {
  const r = await runner.run({
    agent: shimAgent(SLOW), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 700,
  });
  assert.strictEqual(r.error, 'timeout');
  assert.strictEqual(r.exitCode, null, 'a killed process has no exit code of its own');
});

test('a timeout reaps the whole process group, not just the direct child', async () => {
  // Agent CLIs spawn tool subprocesses. Killing only the direct pid leaves
  // those orphaned to PID 1 - still writing files, still billing, invisible.
  const before = countSleepers();
  await runner.run({
    agent: shimAgent(CHILD), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 700,
  });
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(countSleepers(), before, 'a grandchild survived the timeout');
});

test('cancel stops a running agent and reports cancelled', async () => {
  const handle = runner.start({
    agent: shimAgent(SLOW), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 60000,
  });
  await new Promise((r) => setTimeout(r, 300));
  handle.cancel();
  const r = await handle.done;
  assert.strictEqual(r.error, 'cancelled');
});

test('a missing agent binary is reported, not thrown', async () => {
  const r = await runner.run({
    agent: { id: 'ghost', bin: '/definitely/not/here/ghost', buildArgs: (p) => ['-p', p] },
    prompt: 'x', cwd: tmpDir(), logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 5000,
  });
  assert.ok(r.error, 'a missing binary must surface as an error');
  assert.match(r.error, /ghost/, 'the message must name the binary (spec §10)');
});

test('onChunk receives output as it arrives', async () => {
  const chunks = [];
  await runner.run({
    agent: shimAgent(ECHO), prompt: 'streamed', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 10000,
    onChunk: (s) => chunks.push(s),
  });
  assert.ok(chunks.join('').includes('streamed'), 'the caller must be able to stream this to SSE');
});

function countSleepers() {
  const { execSync } = require('child_process');
  try {
    return execSync('pgrep -f "sleep 60" | wc -l', { encoding: 'utf8' }).trim();
  } catch (_) {
    return '0';
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'test/runner.test.js'`

Expected: FAIL with `Cannot find module '../lib/runner'`.

- [ ] **Step 3: Write the implementation**

Create `lib/runner.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Spawns one agent, streams its output to a log file and an optional callback,
// bounds its runtime, and reports how it ended. Knows nothing about orders,
// projects or git - it is handed a cwd and a prompt and reports a result.
//
// The result is always a value, never a throw: "the agent exited 7" and "the
// binary is missing" are outcomes to record, not exceptions to handle.

const KILL_GRACE_MS = 5000;

// Signals the whole process group. Agent CLIs spawn tool subprocesses, and
// signalling only the direct pid leaves those orphaned to PID 1 - still
// writing, still billing, invisible to us.
function reap(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (_) {
    try { child.kill(signal); } catch (__) {}
  }
}

// Returns { done, cancel, pid }. `done` settles with
// { exitCode, error, logFile } and never rejects.
function start({ agent, prompt, cwd, logFile, timeoutMs, env, onChunk }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // Append, not write: the log is the record of what happened and a caller
  // may have already written a header line.
  const log = fs.createWriteStream(logFile, { flags: 'a' });

  let settled = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  let timer = null;
  let child = null;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    log.end();
    resolveDone({ logFile, ...result });
  };

  const write = (buf) => {
    const s = buf.toString();
    log.write(s);
    if (onChunk) {
      try { onChunk(s); } catch (_) { /* a broken consumer must not kill the run */ }
    }
  };

  try {
    child = spawn(agent.bin, agent.buildArgs(prompt), {
      cwd,
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so reap() can signal the whole tree.
      detached: true,
    });
  } catch (e) {
    finish({ exitCode: null, error: `${agent.bin}: ${e.message}` });
    return { done, cancel: () => {}, pid: null };
  }

  child.stdout.on('data', write);
  child.stderr.on('data', write);

  child.on('error', (e) => {
    // ENOENT lands here, not in the try above. Name the binary: spec §10 says
    // a missing agent must say which one.
    log.write(`\n[runner] ${agent.bin}: ${e.message}\n`);
    finish({ exitCode: null, error: `${agent.bin}: ${e.message}` });
  });

  child.on('close', (code) => finish({ exitCode: code, error: null }));

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      if (settled) return;
      log.write(`\n[runner] timeout after ${timeoutMs}ms, terminating\n`);
      reap(child, 'SIGTERM');
      setTimeout(() => reap(child, 'SIGKILL'), KILL_GRACE_MS).unref();
      finish({ exitCode: null, error: 'timeout' });
    }, timeoutMs);
    timer.unref();
  }

  const cancel = () => {
    if (settled) return;
    log.write('\n[runner] cancelled\n');
    reap(child, 'SIGTERM');
    setTimeout(() => reap(child, 'SIGKILL'), KILL_GRACE_MS).unref();
    finish({ exitCode: null, error: 'cancelled' });
  };

  return { done, cancel, pid: child.pid };
}

// Convenience for callers that do not need to cancel.
function run(opts) {
  return start(opts).done;
}

module.exports = { start, run, reap };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test 'test/runner.test.js'`

Expected: PASS — 8 tests, 0 failures.

Then: `node --test 'test/*.test.js'` → 131 passing.

- [ ] **Step 5: Mutation-verify the two properties that cost money**

```bash
# M1: kill only the direct child
#   In reap(), change process.kill(-child.pid, signal) to child.kill(signal)
#   Expect: "a timeout reaps the whole process group" FAILS
# M2: no timeout
#   In start(), change  if (timeoutMs && timeoutMs > 0)  to  if (false)
#   Expect: "a run past its timeout is killed" FAILS (and takes 60s — that is
#           the point: without the timeout, nothing bounds the run)
# M3: a missing binary is silent
#   In the child.on('error') handler, change the error to null
#   Expect: "a missing agent binary is reported" FAILS
```

- [ ] **Step 6: Commit**

```bash
git add lib/runner.js test/runner.test.js
git commit -F- <<'EOF'
feat(runner): spawn one agent, bounded and recorded

Handed a cwd and a prompt, reports how it ended. Knows nothing about orders,
projects or git, so it is testable with a shell shim and no agent is ever
invoked by the suite.

The result is always a value, never a throw: "exited 7" and "the binary is
missing" are outcomes to record, not exceptions. A missing binary names itself,
because an order that failed has to say which agent was not installed.

Two properties are mutation-tested because both cost real money. The timeout is
the only thing bounding a stuck agent. And the kill signals the process group,
not the pid: agent CLIs spawn tool subprocesses, and signalling only the direct
child leaves them orphaned to PID 1 - still writing files, still billing, and
invisible to us.
EOF
```

---

## Task 4: Dispatch an order end to end

**Files:**
- Create: `lib/dispatch.js`
- Test: `test/dispatch.test.js`

This is the module that puts the previous three together: check the budget, prepare the cwd, run, record, clean up. It is the seam 2b's scheduler will call in a loop.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch.test.js`:

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const dispatch = require('../lib/dispatch');
const orders = require('../lib/orders');
const projects = require('../lib/projects');

const created = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'skillspace-dsp-'));
  created.push(d);
  return d;
}
function tmpGitRepo() {
  const d = tmpDir('skillspace-dsprepo-');
  execSync('git init -q', { cwd: d });
  fs.writeFileSync(path.join(d, 'file.txt'), 'original\n');
  execSync('git add -A', { cwd: d });
  execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: d });
  return d;
}
function shimAgent(script) {
  const dir = tmpDir('skillspace-shim-');
  const bin = path.join(dir, 'fake-agent');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return { id: 'fake', bin, buildArgs: (p) => ['-p', p] };
}
after(() => {
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

const OK = '#!/bin/sh\necho "did the work"\nexit 0\n';
const BAD = '#!/bin/sh\necho "broke"\nexit 4\n';

test('a dispatched order runs isolated, succeeds, and is recorded', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'do it' });

  const result = await dispatch.runOrder(root, {
    order, project, agent: shimAgent(OK),
  });

  assert.strictEqual(result.status, 'succeeded');
  const stored = orders.get(root, order.id);
  assert.strictEqual(stored.status, 'succeeded');
  assert.strictEqual(stored.exitCode, 0);
  assert.strictEqual(stored.agent, 'fake');
  assert.ok(stored.startedAt && stored.finishedAt);
  assert.match(fs.readFileSync(path.join(root, 'logs', `${order.id}.log`), 'utf8'), /did the work/);
});

test('the worktree is removed after the order finishes', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });
  const wtRoot = path.join(root, 'worktrees');
  const left = fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [];
  assert.deepStrictEqual(left, [], `worktree left behind: ${JSON.stringify(left)}`);
});

test('a non-zero exit records failed with the exit code, and still cleans up', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  await dispatch.runOrder(root, { order, project, agent: shimAgent(BAD) });

  const stored = orders.get(root, order.id);
  assert.strictEqual(stored.status, 'failed');
  assert.strictEqual(stored.exitCode, 4);
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], []);
});

test('a worktree that cannot be created fails the order before any agent starts', async () => {
  // Spec §10. The shim would exit 0 if it ever ran, so a succeeded status here
  // would prove the abort did not happen.
  const root = tmpDir('skillspace-home-');
  const notARepo = tmpDir('skillspace-plain-');
  const project = { ...projects.create(root, { path: notARepo }), kind: 'git' };
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  const result = await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });

  assert.strictEqual(result.status, 'failed');
  const stored = orders.get(root, order.id);
  assert.match(stored.error, /worktree/);
  assert.strictEqual(stored.startedAt, null, 'no agent should have started');
});

test('maxOrdersPerDay refuses a dispatch and does not spawn', async () => {
  // Spec §8a: counted from persisted orders so it survives a restart.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = {
    ...projects.create(root, { path: repo }),
    budget: { maxOrdersPerGoal: 12, orderTimeoutMs: 900000, maxOrdersPerDay: 1 },
  };
  const first = orders.create(root, { projectId: project.id, prompt: 'one' });
  await dispatch.runOrder(root, { order: first, project, agent: shimAgent(OK) });

  const second = orders.create(root, { projectId: project.id, prompt: 'two' });
  const result = await dispatch.runOrder(root, { order: second, project, agent: shimAgent(OK) });

  assert.strictEqual(result.status, 'failed');
  assert.match(orders.get(root, second.id).error, /daily limit/);
  assert.strictEqual(orders.get(root, second.id).startedAt, null);
});

test('the order timeout comes from the project budget', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = {
    ...projects.create(root, { path: repo }),
    budget: { maxOrdersPerGoal: 12, orderTimeoutMs: 700, maxOrdersPerDay: 100 },
  };
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  await dispatch.runOrder(root, {
    order, project, agent: shimAgent('#!/bin/sh\nsleep 60\n'),
  });
  const stored = orders.get(root, order.id);
  assert.strictEqual(stored.status, 'failed');
  assert.strictEqual(stored.error, 'timeout');
});

test('a dir project runs in place and the directory survives', async () => {
  const root = tmpDir('skillspace-home-');
  const work = tmpDir('skillspace-work-');
  fs.writeFileSync(path.join(work, 'keep.txt'), 'precious');
  const project = projects.create(root, { path: work });
  assert.strictEqual(project.kind, 'dir');
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });

  assert.strictEqual(orders.get(root, order.id).cwd, fs.realpathSync(work));
  assert.ok(fs.existsSync(path.join(work, 'keep.txt')), 'a dir project must never be cleaned up');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'test/dispatch.test.js'`

Expected: FAIL with `Cannot find module '../lib/dispatch'`.

- [ ] **Step 3: Write the implementation**

Create `lib/dispatch.js`:

```js
'use strict';
const path = require('path');
const orders = require('./orders');
const worktrees = require('./worktrees');
const runner = require('./runner');

// Puts one order through its whole life: check the budget, prepare an isolated
// cwd, run the agent, record the outcome, clean up. Plan 2b's scheduler calls
// this in a loop bounded by project.concurrency; nothing here knows about
// queues or goals.

const inFlight = new Map(); // orderId -> runner handle, for cancel

function logFileFor(root, orderId) {
  return path.join(root, 'logs', `${orderId}.log`);
}

async function runOrder(root, { order, project, agent, onChunk }) {
  // Budget first: refusing before a worktree exists means a refused order
  // leaves nothing behind at all.
  const budget = (project && project.budget) || {};
  const cap = budget.maxOrdersPerDay;
  if (cap && orders.countToday(root, project.id) > cap) {
    return orders.markFailed(root, order.id, `daily limit reached (${cap} orders)`);
  }
  if (!agent) {
    return orders.markFailed(root, order.id, 'no agent available');
  }

  let wt;
  try {
    wt = worktrees.prepare(root, project, order.id);
  } catch (e) {
    // Spec §10: fails before any agent spawns, nothing half-created.
    return orders.markFailed(root, order.id, e.message);
  }

  orders.markRunning(root, order.id, { cwd: wt.cwd, agent: agent.id });

  try {
    const handle = runner.start({
      agent,
      prompt: order.prompt,
      cwd: wt.cwd,
      logFile: logFileFor(root, order.id),
      timeoutMs: budget.orderTimeoutMs || 900000,
      onChunk,
    });
    inFlight.set(order.id, handle);
    const result = await handle.done;

    if (result.error === 'cancelled') return orders.markCancelled(root, order.id);
    return orders.markFinished(root, order.id, {
      exitCode: result.exitCode,
      error: result.error,
    });
  } finally {
    inFlight.delete(order.id);
    // Always: a failed run must not leave a worktree holding a branch.
    worktrees.cleanup(root, wt);
  }
}

function cancel(orderId) {
  const handle = inFlight.get(orderId);
  if (!handle) return false;
  handle.cancel();
  return true;
}

module.exports = { runOrder, cancel, logFileFor };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test 'test/dispatch.test.js'`

Expected: PASS — 7 tests, 0 failures.

Then: `node --test 'test/*.test.js'` → 138 passing.

- [ ] **Step 5: Mutation-verify the ordering guarantees**

The value of this module is in *when* things happen, not what.

```bash
# M1: budget checked after the worktree is made
#   Move the maxOrdersPerDay block to just before orders.markRunning
#   Expect: "maxOrdersPerDay refuses a dispatch and does not spawn" still passes,
#           BUT a worktree is created and cleaned. Add this assertion to that
#           test if it does not already fail:
#             assert.deepStrictEqual(fs.readdirSync(path.join(root,'worktrees')), [])
#           and confirm the mutant then fails.
# M2: cleanup only on success
#   Change the `finally` block to run only when result.exitCode === 0
#   Expect: "a non-zero exit ... and still cleans up" FAILS
# M3: worktree failure still spawns
#   In the catch around prepare(), fall through instead of returning
#   Expect: "a worktree that cannot be created fails the order" FAILS
```

- [ ] **Step 6: Commit**

```bash
git add lib/dispatch.js test/dispatch.test.js
git commit -F- <<'EOF'
feat(dispatch): put one order through its whole life

Budget, isolated cwd, run, record, clean up. This is the seam the scheduler
will call in a loop; nothing here knows about queues or goals.

Ordering is the point and it is mutation-tested. The budget is checked before a
worktree exists, so a refused order leaves nothing behind at all. A worktree
that cannot be created fails the order before any agent spawns. And cleanup is
in a finally, because a failed run must not leave a worktree holding a branch -
checking only the success path was the obvious version and it is wrong.
EOF
```

---

## Task 5: Order endpoints, and shrink `server.js`

**Files:**
- Modify: `server.js` — add routes; **delete** the `/api/run` spawn block and delegate to `lib/runner.js`
- Test: `test/orders-api.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/orders-api.test.js`:

```js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const net = require('net');

const created = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

let child, base, storeRoot;

before(async () => {
  const port = await freePort();
  storeRoot = tmp('skillspace-ordersapi-');
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), SKILLSPACE_HOME: storeRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.on('data', () => {});
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server exited early: ' + stderr);
    try { if ((await fetch(base + '/api/config')).ok) break; } catch (_) {}
    if (Date.now() > deadline) throw new Error('server did not start: ' + stderr);
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  if (child) child.kill('SIGKILL');
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

const json = async (method, p, body) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Mode': 'cors' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

async function makeProject() {
  const dir = tmp('skillspace-ordwork-');
  const r = await json('POST', '/api/projects', { path: dir });
  return r.body.project;
}

test('POST /api/orders creates a queued order for a real project', async () => {
  const project = await makeProject();
  const r = await json('POST', '/api/orders', { projectId: project.id, prompt: 'do it' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.order.status, 'queued');
  assert.strictEqual(r.body.order.projectId, project.id);
});

test('POST /api/orders rejects an unknown project with 404', async () => {
  const r = await json('POST', '/api/orders', { projectId: 'prj-nope', prompt: 'x' });
  assert.strictEqual(r.status, 404);
});

test('POST /api/orders rejects a missing prompt with 400, not 500', async () => {
  const project = await makeProject();
  const r = await json('POST', '/api/orders', { projectId: project.id });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /prompt is required/);
});

test('GET /api/orders lists orders, newest first, filterable by project', async () => {
  const a = await makeProject();
  const b = await makeProject();
  await json('POST', '/api/orders', { projectId: a.id, prompt: '1' });
  await json('POST', '/api/orders', { projectId: b.id, prompt: '2' });

  const all = await json('GET', '/api/orders');
  assert.ok(all.body.orders.length >= 2);

  const onlyA = await json('GET', `/api/orders?project=${encodeURIComponent(a.id)}`);
  assert.ok(onlyA.body.orders.every((o) => o.projectId === a.id));
});

test('GET /api/orders/:id returns one order, 404 for unknown', async () => {
  const project = await makeProject();
  const c = await json('POST', '/api/orders', { projectId: project.id, prompt: 'x' });
  const one = await json('GET', `/api/orders/${c.body.order.id}`);
  assert.strictEqual(one.body.order.id, c.body.order.id);
  assert.strictEqual((await json('GET', '/api/orders/ord-nope')).status, 404);
});

test('an order id that is not a plain identifier is refused', async () => {
  for (const bad of ['a%2Fb', '%ZZ', 'a.b']) {
    const r = await fetch(`${base}/api/orders/${bad}`, { headers: { 'Sec-Fetch-Mode': 'cors' } });
    assert.strictEqual(r.status, 400, `id ${bad} got ${r.status}`);
  }
});

test('order routes refuse a top-level navigation', async () => {
  // Same reasoning as /api/run: creating an order spawns a credentialed agent,
  // and a clicked link must not be able to do that.
  const r = await fetch(base + '/api/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Dest': 'document',
    },
    body: JSON.stringify({ projectId: 'x', prompt: 'y' }),
  });
  assert.strictEqual(r.status, 403);
});

test('running orders are reconciled to interrupted on boot', async () => {
  // Spec §10. Write a running order directly, then start a fresh server
  // against the same store and confirm it did not survive as running.
  const home = tmp('skillspace-reconcile-');
  const ordersDir = path.join(home, 'orders');
  fs.mkdirSync(ordersDir, { recursive: true });
  const stuck = {
    id: 'ord-stuck', projectId: 'p', goalId: null, seq: null, title: '', prompt: 'x',
    acceptance: '', agent: 'claude', cwd: '/tmp/gone', status: 'running',
    exitCode: null, verdict: null, error: null, supersedes: null,
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null,
  };
  fs.writeFileSync(path.join(ordersDir, 'ord-stuck.json'), JSON.stringify(stuck, null, 2));

  const port = await freePort();
  const kid = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), SKILLSPACE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kid.stdout.on('data', () => {});
  kid.stderr.on('data', () => {});
  try {
    const b2 = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    for (;;) {
      if (kid.exitCode !== null) throw new Error('server exited early');
      try { if ((await fetch(b2 + '/api/config')).ok) break; } catch (_) {}
      if (Date.now() > deadline) throw new Error('server did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
    const after2 = JSON.parse(fs.readFileSync(path.join(ordersDir, 'ord-stuck.json'), 'utf8'));
    assert.strictEqual(after2.status, 'interrupted');
    assert.strictEqual(after2.error, 'interrupted');
  } finally {
    kid.kill('SIGKILL');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'test/orders-api.test.js'`

Expected: FAIL — the order routes return the catch-all `not found`, so `r.json()` throws `SyntaxError: Unexpected token 'o'`. That is the correct red.

- [ ] **Step 3: Add the requires and boot reconciliation to `server.js`**

Next to the existing `const projects = require('./lib/projects');`:

```js
const orders = require('./lib/orders');
const dispatch = require('./lib/dispatch');
```

And immediately before `server.listen(...)`:

```js
// Spec §10: any order still marked running lost its child process when the
// previous server died. It is never assumed to have succeeded.
try {
  const n = orders.reconcile(SKILLSPACE_HOME);
  if (n) console.log(`  reconciled ${n} interrupted order(s)`);
} catch (e) {
  console.warn('[server] could not reconcile orders:', e.message);
}
```

- [ ] **Step 4: Add the routes**

In `route()`, directly above the `/api/prompt` handler:

```js
  if (p === '/api/orders' && req.method === 'GET') {
    const projectId = u.searchParams.get('project') || null;
    return sendJson(res, 200, {
      orders: orders.list(SKILLSPACE_HOME, projectId ? { projectId } : {}),
    });
  }

  if (p === '/api/orders' && req.method === 'POST') {
    // Creating an order spawns a credentialed agent, so it gets the same
    // navigation guard as /api/run: a clicked link must not be able to do it.
    if (isTopLevelNavigation(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('forbidden: /api/orders is not a navigable URL');
    }
    const body = await readBody(req);
    if (body[ABORTED]) return;
    if (body[OVERSIZE]) return sendJson(res, 413, { error: 'request body too large' });

    const project = projects.get(SKILLSPACE_HOME, String(body.projectId || ''));
    if (!project) return sendJson(res, 404, { error: 'no such project' });
    try {
      const order = orders.create(SKILLSPACE_HOME, {
        projectId: project.id,
        prompt: body.prompt,
        title: body.title,
        acceptance: body.acceptance,
      });
      return sendJson(res, 200, { order });
    } catch (e) {
      // orders.create emits its own required-field shapes; anything else is
      // ours, the same split the project POST route uses.
      const msg = String((e && e.message) || e);
      const clientFault = / is required$/.test(msg);
      return sendJson(res, clientFault ? 400 : 500, { error: msg });
    }
  }

  const orderMatch = p.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && req.method === 'GET') {
    let id;
    try {
      id = decodeURIComponent(orderMatch[1]);
    } catch (_) {
      return sendJson(res, 400, { error: 'invalid order id' });
    }
    if (!isPlainId(id)) return sendJson(res, 400, { error: 'invalid order id' });
    const order = orders.get(SKILLSPACE_HOME, id);
    if (!order) return sendJson(res, 404, { error: 'no such order' });
    return sendJson(res, 200, { order });
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test 'test/orders-api.test.js'`

Expected: PASS — 8 tests, 0 failures.

Then: `node --test 'test/*.test.js'` → 146 passing.

- [ ] **Step 6: Delete the `/api/run` spawn block and delegate to the runner**

`server.js` is over its line ceiling and now has two spawn implementations. Replace the body of the `/api/run` handler — everything from `const runCwd = fs.mkdtempSync(...)` to the `req.on('close', ...)` block — with:

```js
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-run-'));
    const handle = runner.start({
      agent: cmd.agent,
      prompt: cmd.prompt,
      cwd: runCwd,
      logFile: path.join(SKILLSPACE_HOME, 'logs', 'adhoc.log'),
      timeoutMs: RUN_TIMEOUT_MS,
      env: childEnv(cmd.agent),
      onChunk: (s) => send('chunk', s),
    });
    RUNNING.add(handle);
    req.on('close', () => handle.cancel());
    handle.done.then((result) => {
      RUNNING.delete(handle);
      fs.rm(runCwd, { recursive: true, force: true }, () => {});
      if (result.error === 'timeout') send('error', `agent 超时（${RUN_TIMEOUT_MS / 1000}s），已终止`);
      else if (result.error) send('error', result.error);
      send('done', { code: result.exitCode });
      res.end();
    });
    return;
```

Add `const runner = require('./lib/runner');` with the other requires.

**Verify the existing `/api/run` tests still pass** — that route already has coverage for the navigation guard, the unknown agent, the method check and the cwd. If any of them go red, the delegation changed behaviour and the fix is in the delegation, not the test.

Run: `node --test 'test/*.test.js'` → still 146 passing.

- [ ] **Step 7: Confirm `server.js` shrank**

```bash
wc -l server.js
```

Expected: **fewer lines than the 1066 it started at**, despite three new routes. If it grew, the spawn block was not fully removed.

- [ ] **Step 8: Commit**

```bash
git add server.js test/orders-api.test.js
git commit -F- <<'EOF'
feat(api): order endpoints, and one spawn implementation instead of two

POST /api/orders creates a queued order against a real project; GET lists and
reads them. Creating an order spawns a credentialed agent, so POST carries the
same navigation guard as /api/run - a link clicked in Slack or Mail must not be
able to start work.

On boot, any order still marked running is reconciled to interrupted: its child
process died with the previous server and it is never assumed to have
succeeded.

The /api/run spawn block is gone, delegating to lib/runner instead. That route
and the order path now share one implementation of "spawn an agent, bound it,
reap its process group" rather than drifting apart - and server.js is smaller
than it was before this task despite gaining three routes.
EOF
```

---

## Self-review

**Spec coverage.** §3 Order — Task 1, including the `succeeded`/`verified` split (verified is stored, never set here, which is 2b's job). §5 isolation — Task 2, both kinds. §8a `orderTimeoutMs` and `maxOrdersPerDay` — Task 4; `maxOrdersPerGoal` needs a goal and is 2b. §10 error handling — all four cases: missing binary (Task 3), non-zero exit (Tasks 3–4), worktree failure before spawn (Tasks 2 and 4), boot reconciliation (Tasks 1 and 5). §11 testing — every listed case has a test except the PM-parse and `maxOrdersPerGoal` items, which belong to 2b, and the end-to-end-against-a-real-agent item, which is deliberately not automated because the suite must never spend money.

**Gap I am recording rather than fixing:** the spec's §4 flow and the scheduler are absent by design; 2a dispatches one order at a time from the route that creates it. `project.concurrency` is therefore stored and still unread after this plan. That is the same "registry with nothing consuming it" shape Plan 1 ended on, one layer up, and 2b closes it.

**Type consistency.** `orders.markFinished(root, id, { exitCode, error })` is called that way in Task 4. `worktrees.prepare(root, project, orderId)` returns `{ cwd, isolated, branch, projectPath }` and `cleanup(root, wt)` reads `isolated`, `cwd`, `projectPath`, `branch` — all set by `prepare`. `runner.start(...)` returns `{ done, cancel, pid }`; Task 4 uses `handle.done` and `handle.cancel`, Task 5 uses both plus `RUNNING.add(handle)` — note this changes what `RUNNING` holds from a child process to a handle, which is why Task 5 replaces the `req.on('close')` reap with `handle.cancel()`.

**Placeholder scan:** no TBDs, every code step carries real code, every command carries an expected result.

---

## What this plan does not do

- **No scheduler.** One order runs per request. `concurrency` is unread until 2b.
- **No goals, no PM, no verdicts.** The fields exist on the record and stay null.
- **No `node_modules` reuse** across worktrees — spec §5 records the cost rather than paying it.
- **No UI.** Orders are API-only until Plan 3. The rail still cannot start one.
- **No cross-process locking.** Each order is its own file, so two writers collide only on the same order rather than on a shared array — better than `projects.json`, still unlocked.
