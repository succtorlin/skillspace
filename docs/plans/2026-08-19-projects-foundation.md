# Projects Foundation — Implementation Plan (1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give SkillSpace durable projects — create, list, delete, switch — backed by an atomic on-disk store that survives restart.

**Architecture:** Extract logic out of the 642-line `server.js` into small focused modules under `lib/`. `server.js` keeps HTTP routing only and delegates. The store writes JSON atomically (temp file + rename) so a crash mid-write cannot leave an unparseable record. Projects detect their own kind (`git` vs `dir`) from the filesystem rather than trusting user input, because kind decides isolation later.

**Tech Stack:** Plain Node 24, no framework. Tests use the built-in `node:test` runner and `node:assert` — no new dependencies, matching the project's three-dependency pitch.

---

## Scope of this plan

From `docs/specs/2026-08-19-projects-and-agent-orchestration-design.md`:

- **Plan 1 (this one):** §3 Project, §6 persistence, §7 project endpoints, §8 project rail.
- **Plan 2:** §3 Goal/Order, §4 flow, §5 isolation, §8a budget, scheduler.
- **Plan 3:** §8 board + order drawer, live log streaming.

Plan 1 ships something useful alone: you can register projects and switch between them, with the skill sources scoped per project.

## File structure

| File | Responsibility | Approx |
|---|---|---|
| `lib/store.js` | Atomic read/write/list of JSON records under `~/.skillspace/`. Knows nothing about projects. | 110 |
| `lib/projects.js` | Project shape, kind detection, CRUD on top of `store`. | 120 |
| `test/store.test.js` | Store behaviour including crash-safety. | 90 |
| `test/projects.test.js` | Project rules including non-destructive delete. | 110 |
| `server.js` | HTTP routes only; delegates to `lib/`. | +60 |
| `public/app.js` | Project rail rendering and switching. | +90 |

`server.js` is already 642 lines and `public/app.js` 742 — both near the 800-line ceiling. Adding four subsystems inline would blow past it, so logic goes to `lib/` from the first task.

---

### Task 1: Atomic JSON store

**Files:**
- Create: `lib/store.js`
- Test: `test/store.test.js`

- [ ] **Step 1: Add the test script**

Modify `package.json` scripts:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  },
```

- [ ] **Step 2: Write the failing test**

Create `test/store.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/store');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-test-'));
}

test('writeJson then readJson round-trips', () => {
  const root = tmpRoot();
  store.writeJson(root, 'projects.json', { a: 1 });
  assert.deepStrictEqual(store.readJson(root, 'projects.json', null), { a: 1 });
});

test('readJson returns the fallback when the file is absent', () => {
  const root = tmpRoot();
  assert.deepStrictEqual(store.readJson(root, 'nope.json', []), []);
});

test('readJson returns the fallback when the file is corrupt, and keeps the bad file', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'bad.json'), '{ not json');
  assert.deepStrictEqual(store.readJson(root, 'bad.json', []), []);
  // the corrupt content must survive for diagnosis, never be silently dropped
  assert.ok(fs.existsSync(path.join(root, 'bad.json.corrupt')));
});

test('writeJson leaves no temp file behind', () => {
  const root = tmpRoot();
  store.writeJson(root, 'x.json', { ok: true });
  const stray = fs.readdirSync(root).filter((f) => f.includes('.tmp'));
  assert.deepStrictEqual(stray, []);
});

test('writeJson creates nested directories', () => {
  const root = tmpRoot();
  store.writeJson(root, 'orders/ord-1.json', { id: 'ord-1' });
  assert.deepStrictEqual(store.readJson(root, 'orders/ord-1.json', null), { id: 'ord-1' });
});

test('list returns ids of records in a subdirectory', () => {
  const root = tmpRoot();
  store.writeJson(root, 'orders/ord-1.json', { id: 'ord-1' });
  store.writeJson(root, 'orders/ord-2.json', { id: 'ord-2' });
  assert.deepStrictEqual(store.list(root, 'orders').sort(), ['ord-1', 'ord-2']);
});

test('list returns empty for a missing subdirectory', () => {
  assert.deepStrictEqual(store.list(tmpRoot(), 'orders'), []);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/Documents/GitHub/skillspace && npm test`
Expected: FAIL — `Cannot find module '../lib/store'`

- [ ] **Step 4: Write the implementation**

Create `lib/store.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');

// Durable JSON records. Knows nothing about what it stores — projects, goals
// and orders all use it. Every write is atomic so a crash mid-write can never
// leave a half-written file that fails to parse on next boot.

function abs(root, rel) {
  const full = path.join(root, rel);
  if (!full.startsWith(root)) throw new Error('path escapes store root: ' + rel);
  return full;
}

function writeJson(root, rel, value) {
  const full = abs(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // Write to a sibling temp file then rename. rename(2) is atomic on the same
  // filesystem, so a reader sees either the old file or the new one, never a
  // partial write.
  const tmp = full + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, full);
}

function readJson(root, rel, fallback) {
  const full = abs(root, rel);
  if (!fs.existsSync(full)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (_) {
    // Keep the corrupt file for diagnosis rather than deleting evidence, then
    // fall back so a single bad record cannot stop the app from booting.
    try { fs.renameSync(full, full + '.corrupt'); } catch (__) {}
    return fallback;
  }
}

function list(root, sub) {
  const dir = abs(root, sub);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
}

module.exports = { writeJson, readJson, list };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 7 tests, 0 failures

- [ ] **Step 6: Commit**

```bash
git add package.json lib/store.js test/store.test.js
git commit -m "feat(store): atomic JSON record store

Every write goes to a temp file then rename(2), which is atomic on the same
filesystem, so a crash mid-write cannot leave a half-written record that fails
to parse on next boot.

A corrupt file is renamed to .corrupt rather than deleted: the evidence
survives for diagnosis, and one bad record cannot stop the app booting."
```

---

### Task 2: Project model and kind detection

**Files:**
- Create: `lib/projects.js`
- Test: `test/projects.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/projects.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const projects = require('../lib/projects');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-proj-'));
}
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-work-'));
}
function tmpGitRepo() {
  const d = tmpDir();
  execSync('git init -q', { cwd: d });
  return d;
}

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/projects'`

- [ ] **Step 3: Write the implementation**

Create `lib/projects.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = 'projects.json';

const DEFAULT_BUDGET = {
  maxOrdersPerGoal: 12,
  orderTimeoutMs: 900000, // 15 minutes
  maxOrdersPerDay: 100,
};

// Kind is DETECTED, never taken from the caller: it decides whether agents can
// be isolated in worktrees, so a wrong value would let two agents corrupt one
// working tree.
function detectKind(dir) {
  return fs.existsSync(path.join(dir, '.git')) ? 'git' : 'dir';
}

function newId() {
  return 'prj-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

function list(root) {
  return store.readJson(root, FILE, []);
}

function create(root, input) {
  const dir = input.path;
  if (!dir || !fs.existsSync(dir)) throw new Error('path does not exist: ' + dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error('path is not a directory: ' + dir);

  const kind = detectKind(dir);
  // A plain directory has no isolation mechanism, so it is serialised rather
  // than allowed to run agents concurrently over one working tree.
  const concurrency = kind === 'git' ? (input.concurrency || 2) : 1;

  const project = {
    id: newId(),
    name: input.name || path.basename(dir),
    kind,
    path: dir,
    branch: input.branch || null,
    skillSources: input.skillSources || [],
    agents: input.agents || [],
    concurrency,
    budget: { ...DEFAULT_BUDGET, ...(input.budget || {}) },
    createdAt: new Date().toISOString(),
  };

  const all = list(root);
  all.push(project);
  store.writeJson(root, FILE, all);
  return project;
}

function get(root, id) {
  return list(root).find((p) => p.id === id) || null;
}

// Removes the RECORD only. The user's working directory is never touched —
// deleting a project must never delete their code.
function remove(root, id) {
  const all = list(root).filter((p) => p.id !== id);
  store.writeJson(root, FILE, all);
}

module.exports = { detectKind, create, list, get, remove, DEFAULT_BUDGET };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 18 tests total, 0 failures

- [ ] **Step 5: Commit**

```bash
git add lib/projects.js test/projects.test.js
git commit -m "feat(projects): project model with detected kind and safe delete

Kind is detected from the filesystem, never taken from the caller: it decides
whether agents can be isolated in git worktrees, so a wrong value would let two
agents corrupt one working tree. A dir project is forced to concurrency 1 and
cannot be raised, because it has no isolation mechanism available.

remove() deletes the record only and never the working directory. There is a
test asserting the user's files survive, because this is a safety property
rather than an implementation detail."
```

---

### Task 3: Project HTTP endpoints

**Files:**
- Modify: `server.js` (add requires near the existing ones at the top; add routes beside the other `/api/` handlers)
- Test: `test/projects-api.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/projects-api.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The API layer is thin: these assert the contract server.js must expose.
// They exercise lib/projects through the same shapes the routes use.
const projects = require('../lib/projects');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-api-'));
}
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-apiwork-'));
}

test('POST shape: creating with a name and path yields a listable project', () => {
  const root = tmpRoot();
  const created = projects.create(root, { name: 'API', path: tmpDir() });
  const listed = projects.list(root);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].id, created.id);
});

test('GET shape: list is an array and is empty before anything is created', () => {
  assert.deepStrictEqual(projects.list(tmpRoot()), []);
});

test('DELETE shape: removing an unknown id is a no-op, not an error', () => {
  const root = tmpRoot();
  projects.create(root, { name: 'A', path: tmpDir() });
  projects.remove(root, 'prj-does-not-exist');
  assert.strictEqual(projects.list(root).length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: PASS for the first two, FAIL is not expected here — these assert the
library contract the routes depend on. If any fail, Task 2 is incomplete; fix
that before continuing.

- [ ] **Step 3: Add the store root and requires to `server.js`**

Add near the top of `server.js`, after the existing `const { spawn, execSync } = require('child_process');` line:

```js
const projects = require('./lib/projects');

// All durable records live outside both the app directory and the user's repos,
// so upgrading SkillSpace never touches data and a project directory never
// gains SkillSpace files.
const SKILLSPACE_HOME = path.join(os.homedir(), '.skillspace');
```

If `os` is not already required at the top of `server.js`, add:

```js
const os = require('os');
```

- [ ] **Step 4: Add the routes**

Add to the request handler in `server.js`, directly above the existing
`if (p === '/api/config') {` line:

```js
  if (p === '/api/projects' && req.method === 'GET') {
    return sendJson(res, 200, { projects: projects.list(SKILLSPACE_HOME) });
  }

  if (p === '/api/projects' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const project = projects.create(SKILLSPACE_HOME, body);
      return sendJson(res, 200, { project });
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }

  if (p.startsWith('/api/projects/') && req.method === 'DELETE') {
    const id = p.slice('/api/projects/'.length);
    projects.remove(SKILLSPACE_HOME, id);
    // The record is gone; the working directory is deliberately untouched.
    return sendJson(res, 200, { ok: true, filesKept: true });
  }
```

- [ ] **Step 5: Verify the routes by hand**

Run:

```bash
pkill -f "node server.js"; sleep 1
(PORT=4177 node server.js > /tmp/ss.log 2>&1 &); sleep 3
curl -s -X POST http://localhost:4177/api/projects \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"SkillSpace\",\"path\":\"$HOME/Documents/GitHub/skillspace\"}"
echo
curl -s http://localhost:4177/api/projects
```

Expected: the POST returns a project with `"kind":"git"` and `"concurrency":2`;
the GET returns that project inside a `projects` array.

- [ ] **Step 6: Commit**

```bash
git add server.js test/projects-api.test.js
git commit -m "feat(api): project endpoints backed by the durable store

Records live under ~/.skillspace/, outside both the app directory and the
user's repos: upgrading SkillSpace never touches data, and registering a
project never puts SkillSpace files inside someone's repository.

DELETE removes the record and responds filesKept:true, making the
non-destructive contract visible in the response rather than only in a doc."
```

---

### Task 4: Project rail in the console

**Files:**
- Modify: `public/index.html` (sidebar, above the existing `.side-label` block)
- Modify: `public/app.js` (add the rail renderer; wire it into the existing boot path)
- Modify: `public/style.css` (rail styles, on existing tokens)

- [ ] **Step 1: Add the markup**

In `public/index.html`, directly above the existing `<div class="side-label">Skill 来源</div>`, insert:

```html
      <div class="side-label">项目</div>
      <nav class="nav" id="project-list" aria-label="项目列表"></nav>
      <button id="add-project" class="add-dir">添加项目</button>
```

- [ ] **Step 2: Add the styles**

Append to `public/style.css`:

```css
/* Project rail — same grammar as the source list, one ground step apart so the
   two rails read as siblings rather than as one undifferentiated column. */
.proj-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 7px 9px; border-radius: 8px; cursor: pointer;
  background: transparent; border: 1px solid transparent;
  color: var(--ink-2); font-size: 13px; text-align: left;
}
.proj-item:hover { background: var(--ground-2); color: var(--ink); }
.proj-item.active {
  background: var(--ground-2); color: var(--ink); border-color: var(--hair-lit);
}
.proj-kind {
  margin-left: auto; font-family: var(--face-mono); font-size: 10px;
  letter-spacing: .1em; text-transform: uppercase; color: var(--muted);
}
.proj-item.active .proj-kind { color: var(--accent); }
```

- [ ] **Step 3: Add the renderer**

Append to `public/app.js`:

```js
// ---------- 项目 ----------
async function loadProjects() {
  const list = document.getElementById('project-list');
  if (!list) return;
  let data = { projects: [] };
  try {
    data = await fetch('/api/projects').then((r) => r.json());
  } catch (e) {
    list.innerHTML = '';
    return;
  }
  const activeId = localStorage.getItem('skillspace-project') || '';
  list.innerHTML = data.projects
    .map(
      (p, i) =>
        `<button class="proj-item${p.id === activeId ? ' active' : ''}" data-i="${i}">` +
        `<span>${esc(p.name)}</span>` +
        // kind is shown because it decides how many agents may run at once
        `<span class="proj-kind">${p.kind}</span>` +
        `</button>`
    )
    .join('');
  list.querySelectorAll('.proj-item').forEach((el) =>
    el.addEventListener('click', () => {
      localStorage.setItem('skillspace-project', data.projects[+el.dataset.i].id);
      loadProjects();
    })
  );
}

async function addProject() {
  const picked = await fetch('/api/pick-dir').then((r) => r.json()).catch(() => null);
  if (!picked || !picked.dir) return;
  const r = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: picked.dir }),
  }).then((x) => x.json());
  if (r.error) return toast('添加项目失败：' + r.error, 'error');
  toast('已添加项目：' + r.project.name);
  loadProjects();
}
```

- [ ] **Step 4: Wire it into boot**

In `public/app.js`, find the existing boot call that runs on load (the call to
`loadSources()`), and add immediately after it:

```js
loadProjects();
const addProjBtn = document.getElementById('add-project');
if (addProjBtn) addProjBtn.addEventListener('click', addProject);
```

- [ ] **Step 5: Verify in the browser**

Run:

```bash
pkill -f "node server.js"; sleep 1
(PORT=4177 node server.js > /tmp/ss.log 2>&1 &); sleep 3
curl -s http://localhost:4177/api/projects
```

Then open `http://localhost:4177/` and confirm: the 项目 rail lists the project
created in Task 3 with a `GIT` marker, clicking it marks it active, and the
marker turns mint when selected.

- [ ] **Step 6: Run the preset gates**

The console is preset-governed; a new surface must not break it.

Run:

```bash
cd ~/Documents/GitHub/BGSU1/web-app
node ~/.claude/skills/fantastic-ui/scripts/verify-preset.mjs \
  --url http://localhost:4177 --preset F --theme-key skillspace-theme --themes dark,light
```

Expected: all gates pass. If contrast fails on `.proj-kind`, raise it from
`--muted` to `--ink-2` rather than inventing a new colour.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat(ui): project rail

Lists durable projects above the skill sources, on the same grammar. The kind
marker (GIT / DIR) is shown rather than hidden because it decides how many
agents may run against that project at once, which is the first thing a user
needs to know when they attach agents in plan 2."
```

---

## Self-review

**Spec coverage for this plan's scope:**

| Spec | Task |
|---|---|
| §3 Project shape | 2 |
| §3 kind detected, decides isolation | 2 (`detectKind`, concurrency forcing) |
| §6 atomic writes, `~/.skillspace/` | 1, 3 |
| §6 corrupt record does not stop boot | 1 |
| §7 GET/POST/DELETE projects | 3 |
| §7 delete never touches files | 2 (test), 3 (`filesKept`) |
| §8 project rail | 4 |
| §8a budget defaults on the project | 2 |

Deferred by design to plans 2 and 3, not missing: goals, orders, scheduler,
worktrees, timeout enforcement, board, log streaming.

**Placeholders:** none — every step contains the code or the exact command.

**Type consistency:** `store.readJson(root, rel, fallback)` / `writeJson(root, rel, value)` / `list(root, sub)` are used with those signatures in `lib/projects.js` and Task 3. `projects.create/list/get/remove(root, ...)` match between Task 2, Task 3 and the tests. `budget` keys `maxOrdersPerGoal`, `orderTimeoutMs`, `maxOrdersPerDay` match §8a of the spec exactly.

**Carried into Plan 2 — route-level id validation.** `lib/store.abs()` guarantees
a path stays inside the store root, but NOT inside the intended subdirectory:
`orders/../store-evil.json` resolves within the root, so the store is right to
allow it. An order id of `../store-evil` could therefore write into a different
collection's namespace. When `/api/orders/:id/log` and `/api/goals/:id` are
built, `:id` must be validated at the route boundary against `/^[A-Za-z0-9_-]+$/`.
Found during Task 1 implementation, recorded here so it is not rediscovered as
a bug.

**Known gap carried forward:** Task 4 reuses `/api/pick-dir`, the existing macOS
`osascript` folder picker. On non-macOS it returns null and 添加项目 silently does
nothing. Plan 2 should add a text-entry fallback; noting it here so it is not
discovered as a mystery bug.
