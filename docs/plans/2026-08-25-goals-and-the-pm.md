# Goals and the PM — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** State a goal against a project and have a PM agent fan it into reviewable work orders — persisted, budget-bounded, and readable before anything executes.

**Architecture:** Two new modules under `lib/`: `goals.js` persists the goal record and its lifecycle, `pm.js` owns the PM prompt and the extraction of JSON from an agent's prose. The PM runs through the existing `runner` in an isolated worktree, exactly like any other agent — no second spawn path. Task 1 first pays down two structural debts Plan 2a's reviewers flagged as cheapest to clear *before* new modules are written against the old shape.

**Tech Stack:** Plain Node 24, zero runtime dependencies, `node:test`, no framework, no build step. Builds on Plan 2a's `lib/orders.js`, `lib/worktrees.js`, `lib/runner.js`, `lib/dispatch.js`.

---

## Scope of this plan

The design's remaining work (`§3 Goal, §4 flow, §8a maxOrdersPerGoal, the scheduler`) splits the same way Plan 2 did, and for the same reason — Plan 2a was five tasks, 29 commits and roughly twenty review rounds.

| | Scope | Ships |
|---|---|---|
| **2b — this plan** | Consolidation, §3 Goal, §4 decomposition, §8a `maxOrdersPerGoal` | State a goal → the PM fans it into orders → **read them before anything runs**, dispatch them individually with 2a's endpoint |
| **2c — next** | The scheduler loop, §4 verdicts, `supersedes` | Orders run themselves up to `concurrency`, and the PM judges each result against its `acceptance` |
| **3** | §8 board + order drawer, live log streaming | Watch it happen |

**2b ships alone, and the thing it ships is worth having on its own.** The spec's §9 lists *"No approval gate. A dispatched worker modifies its worktree immediately"* as a v1 limitation. A goal that decomposes into orders a human reads before dispatching **is** that gate — for free, and only until 2c automates it. Building the reviewable step first is also the safer order: a bad PM prompt produces a bad plan you can see, rather than six agents already editing worktrees.

**Explicitly deferred to 2c:** the scheduler loop, `verdict` (stored since 2a, still never set), `supersedes`, and dispatching a goal's orders automatically. In this plan a goal reaches `planning → running` only when a human dispatches its orders one at a time.

## File structure

| File | Responsibility | Approx |
|---|---|---|
| `lib/goals.js` | Goal shape, lifecycle, CRUD on `store`, the `maxOrdersPerGoal` decision. Knows nothing about agents. | 180 |
| `lib/pm.js` | The PM prompt, and extracting a JSON plan from an agent's prose. Pure — no spawning, no store. | 150 |
| `lib/plan.js` | Runs the PM through `runner` in an isolated cwd and turns its output into persisted orders. The seam 2c's scheduler will call. | 170 |
| `routes/goals.js` | `POST /api/goals`, `GET /api/goals`, `GET /api/goals/:id`. | 120 |
| `test/goals.test.js` · `test/pm.test.js` · `test/plan.test.js` · `test/goals-api.test.js` | | 700 |
| `server.js` | Route wiring only; **Task 1 removes more than it adds**. | −40 |
| `routes/orders.js` | Task 1 deletes its duplicate registry. | −25 |

`server.js` is 1069 lines against this project's 800 ceiling. Task 1 is the only task that touches it and it takes lines *out*; every new decision in this plan lands in `lib/`.

### Why `pm.js` is separate from `plan.js`

The PM prompt and the JSON extraction are pure string work, and they are the part most likely to need iteration once a real agent is producing output. Keeping them free of spawning and persistence means they can be table-tested against captured agent transcripts — including malformed ones — without a shim, a worktree, or a store. `plan.js` is then thin enough to test with one shim.

---

## Task 1: One registry, one context factory

**Files:**
- Modify: `server.js`, `routes/orders.js`, `routes/projects.js`
- Test: `test/orders-api.test.js` (existing — must pass **unedited** except where noted)

Plan 2a's reviewers flagged both of these as cheapest now, before three more route modules are written against the current shape. This task changes no behaviour a user can see; the existing suites are the proof.

- [ ] **Step 1: Write the failing test**

Add to `test/orders-api.test.js`:

```js
test('the process-wide agent ceiling is MAX_CONCURRENT_RUNS, not twice it', async () => {
  // /api/run and /api/orders each capped independently, so the real ceiling
  // was 2x the constant. One registry means one ceiling.
  // startServer(home, extraEnv) - TWO arguments. Passing one object makes it
  // the home and never sets SKILLSPACE_MAX_RUNS, so the ceiling silently stays
  // at the default 4 and this test passes vacuously.
  const { child: kid, port } = await startServer(tmp('skillspace-ceiling-'), { SKILLSPACE_MAX_RUNS: '2' });
  const b2 = `http://127.0.0.1:${port}`;
  try {
    const p1 = await makeProjectOn(b2);
    const p2 = await makeProjectOn(b2);
    const a = await fetch(`${b2}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Mode': 'cors' },
      body: JSON.stringify({ projectId: p1.id, prompt: 'SLOW-AGENT one' }),
    });
    const b = await fetch(`${b2}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Mode': 'cors' },
      body: JSON.stringify({ projectId: p2.id, prompt: 'SLOW-AGENT two' }),
    });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    // Both order slots are now taken. /api/run must see the same full pool.
    const run = await fetch(`${b2}/api/run?skill=x&task=SLOW-AGENT three`, {
      headers: { 'Sec-Fetch-Mode': 'cors' },
    });
    const text = await run.text();
    assert.ok(
      run.status === 429 || /too many/.test(text),
      `/api/run kept its own pool: ${run.status} ${text.slice(0, 80)}`
    );
  } finally {
    kid.kill('SIGKILL');
  }
});
```

`startServer` and `makeProjectOn` already exist in that file; if `makeProjectOn` does not, add it as a two-line helper that POSTs a fresh `tmp()` directory to `/api/projects` on the given base and returns the project.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'test/orders-api.test.js'`

Expected: FAIL — `/api/run` accepts a third agent because it counts its own pool.

**Node 24 requires the quoted glob** — `node --test test/` fails, because Node ≥23 treats positional args as file paths.

- [ ] **Step 3: Delete the duplicate registry**

In `routes/orders.js`, remove `RUNNING_ORDERS` entirely and its three touch points. The bound check becomes:

```js
    // One registry. dispatch owns in-flight state because it owns the claim
    // and the release; a second Set here tracked the same fact and released at
    // a different moment, so the two could disagree mid-shutdown.
    if (dispatch.inFlightCount() >= maxConcurrentRuns) {
      return sendJson(res, 429, { error: `too many orders running (${maxConcurrentRuns})` });
    }
```

Delete the `.finally(() => RUNNING_ORDERS.delete(order.id))` from the fire-and-forget chain, keeping the `.catch` that marks the order failed.

In `server.js`, make `/api/run` share the same count. It tracks its own handles in `RUNNING`; leave that Set (it needs the handles for shutdown) but gate on the sum:

```js
    // The two routes share one ceiling. Counting only this route's pool made
    // the real process limit twice the configured number.
    if (RUNNING.size + dispatch.inFlightCount() >= MAX_CONCURRENT_RUNS) {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test 'test/orders-api.test.js'`
Expected: PASS.

Then `node --test 'test/*.test.js'` — 214 passing (213 + 1). Count it; if it disagrees, say so.

- [ ] **Step 5: Turn `ctx` into a factory**

The per-request object carries nine process constants rebuilt on every request, and three more route modules are about to want their own. Bind constants once at construction:

In `server.js`, replace the `const ctx = {...}` block and the two calls with:

```js
// Constants bind once; only the four per-request values are rebuilt. A route
// that needs a new capability now names it in one signature rather than
// reaching into a shared bag that every module can see.
const routeDeps = {
  root: SKILLSPACE_HOME,
  sendJson, readBody, OVERSIZE, ABORTED,
  plainIdFrom, isTopLevelNavigation, denyNavigation,
  AGENTS, maxConcurrentRuns: MAX_CONCURRENT_RUNS, childEnv,
};
const projectRoutes = require('./routes/projects')(routeDeps);
const orderRoutes = require('./routes/orders')(routeDeps);
```
The `require` calls go at the top with the others, but the **invocation** cannot:
`OVERSIZE` and `ABORTED` are `const` further down `server.js`, so calling the
factories at line 17 is a temporal-dead-zone throw at boot. Require at the top,
invoke once at module scope *below* those consts - still once per process.

In the handler:
```js
  const rq = { req, res, u, p };
  if (await projectRoutes(rq)) return;
  if (await orderRoutes(rq)) return;
```

In each route module, change the export to a factory:
```js
module.exports = (deps) => {
  const { root, sendJson, readBody, OVERSIZE, ABORTED, plainIdFrom,
          isTopLevelNavigation, denyNavigation, AGENTS, maxConcurrentRuns,
          childEnv } = deps;
  return async ({ req, res, u, p }) => {
    // ...existing body, unchanged
  };
};
```
`routes/projects.js` destructures only what it uses — do not give it keys it does not need.

- [ ] **Step 6: Run both suites**

Run: `node --test 'test/orders-api.test.js'` then `node --test 'test/projects-api.test.js'`
Expected: 214-ish and 35, **both green with `test/projects-api.test.js` unedited.**

That file is the safety net: it drives HTTP and knows nothing about wiring. **If it needs editing, the refactor changed behaviour — say so rather than adjusting the test.**

- [ ] **Step 7: Mutation-verify**

```bash
# M1: revert the ceiling to this route's own pool
#   In routes/orders.js, gate on a local counter instead of dispatch.inFlightCount()
#   Expect: "the process-wide agent ceiling" FAILS
# M2: factory captures a stale root
#   Bind `root` inside the returned function from a module-level `let` never set
#   Expect: several orders-api tests FAIL (not a silent pass)
```

- [ ] **Step 8: Commit**

```bash
git add server.js routes/ test/orders-api.test.js
git commit -F- <<'EOF'
refactor: one in-flight registry, one context factory

routes/orders.js kept its own Set of running orders alongside dispatch's, and
the two released at different moments - this one in a .finally on runOrder,
dispatch's inside runOrder's own finally - so they could disagree mid-shutdown.
dispatch owns the claim and the release, so it owns the count. That also closes
the 2x ceiling: /api/run and the orders route each capped at
MAX_CONCURRENT_RUNS independently, making the real process limit twice the
configured number.

ctx was a thirteen-key bag rebuilt on every request, nine of whose keys were
process constants, and three more route modules are about to want their own.
Constants now bind once at construction and only the four per-request values
are rebuilt, so a route names its dependencies in a signature instead of
reaching into a bag every module can see.

No behavioural change: test/projects-api.test.js passes unedited, which is what
makes that claim checkable.
EOF
```

---

> **Task 1 outcome (landed as `34ac657`, 215 tests).** Three errors in this
> plan's own Task 1 were caught by executing it, and they are recorded here
> because they are the shape to watch for in Tasks 2-5:
>
> 1. **The prescribed fix was one-directional.** It closed the 2x ceiling for
>    `/api/run` but not for the orders route, so an order could still be
>    admitted while `/api/run` held the only slot - two agents at a ceiling of
>    one, reproduced on the parent commit by the reviewer independently.
> 2. **The prescribed test did not pin the prescribed fix.** Under the mutant
>    that reverts the orders gate, the suite was 214/215 and the only failure
>    was a test the *implementer* added. Following this plan literally would
>    have produced a green suite over a live bug.
> 3. **The prescribed test would have passed vacuously** on a wrong
>    `startServer` signature, and one instruction (invoke the factories beside
>    the top-level requires) was a temporal-dead-zone throw.
>
> The lesson for the tasks below: **a test written in this plan is a starting
> point, not a specification.** If a mutant survives, the test is wrong, not
> the mutant - add the test that kills it and say so.

## Task 2: The goal record

**Files:**
- Create: `lib/goals.js`
- Test: `test/goals.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/goals.test.js`:

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const goals = require('../lib/goals');

const created = [];
function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-goals-'));
  created.push(d);
  return d;
}
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

test('create stores a goal and returns it planning', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'prj-1', text: 'make the tests green' });
  assert.ok(g.id.startsWith('goal-'));
  assert.strictEqual(g.status, 'planning');
  assert.strictEqual(g.projectId, 'prj-1');
  assert.strictEqual(g.text, 'make the tests green');
  assert.deepStrictEqual(g.orderIds, []);
  assert.strictEqual(g.pmAgent, null);
  assert.strictEqual(g.error, null);
  assert.strictEqual(g.rawPlan, null);
  assert.ok(!Number.isNaN(Date.parse(g.createdAt)));
});

test('create requires a projectId and a text', () => {
  const root = tmpRoot();
  assert.throws(() => goals.create(root, { text: 'x' }), /projectId is required/);
  assert.throws(() => goals.create(root, { projectId: 'p' }), /text is required/);
  assert.throws(() => goals.create(root, { projectId: 'p', text: '   ' }), /text is required/);
});

test('an over-long text is rejected, never truncated', () => {
  // Same reasoning as an order's prompt: a shortened goal is a DIFFERENT goal
  // that still looks plausible, and the PM would decompose it without anyone
  // noticing the human asked for something else.
  const root = tmpRoot();
  assert.throws(
    () => goals.create(root, { projectId: 'p', text: 'x'.repeat(100001) }),
    /text is too long/
  );
  assert.strictEqual(goals.create(root, { projectId: 'p', text: 'x'.repeat(100000) }).text.length, 100000);
});

test('a goal round-trips through the store', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  assert.deepStrictEqual(goals.get(root, g.id), g);
});

test('get returns null for an unknown id, never undefined', () => {
  assert.strictEqual(goals.get(tmpRoot(), 'goal-nope'), null);
});

test('list returns goals newest first, filterable by project', () => {
  const root = tmpRoot();
  const a = goals.create(root, { projectId: 'p1', text: '1' });
  const b = goals.create(root, { projectId: 'p2', text: '2' });
  assert.deepStrictEqual(goals.list(root).map((g) => g.id), [b.id, a.id]);
  assert.strictEqual(goals.list(root, { projectId: 'p1' }).length, 1);
});

test('planned records the orders and moves the goal to running', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  const done = goals.planned(root, g.id, {
    orderIds: ['ord-a', 'ord-b'],
    pmAgent: 'claude',
    rawPlan: '[{"title":"a"},{"title":"b"}]',
  });
  assert.strictEqual(done.status, 'running');
  assert.deepStrictEqual(done.orderIds, ['ord-a', 'ord-b']);
  assert.strictEqual(done.pmAgent, 'claude');
  assert.match(done.rawPlan, /title/);
});

test('failPlanning records the reason and keeps the raw output', () => {
  // A PM that cannot produce orders is a prompt problem the human needs to
  // see, so the unparseable output is retained rather than discarded.
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  const done = goals.failPlanning(root, g.id, 'pm returned no JSON plan', 'I think we should...');
  assert.strictEqual(done.status, 'failed');
  assert.match(done.error, /no JSON plan/);
  assert.strictEqual(done.rawPlan, 'I think we should...');
  assert.deepStrictEqual(done.orderIds, []);
});

test('a settled goal is never rewritten', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  goals.failPlanning(root, g.id, 'first reason', 'raw');
  const again = goals.planned(root, g.id, { orderIds: ['ord-a'], pmAgent: 'claude', rawPlan: '[]' });
  assert.strictEqual(again.status, 'failed', 'a settled goal must stay settled');
  assert.strictEqual(again.error, 'first reason');
});

test('withinBudget accepts a plan at the cap and rejects one over it', () => {
  // Spec 8a: a plan over the cap fails the goal WHOLE, never truncated -
  // running the first 12 of a 30-order plan produces a half-executed goal
  // that looks complete, which is worse than refusing.
  assert.strictEqual(goals.withinBudget(12, { maxOrdersPerGoal: 12 }), true);
  assert.strictEqual(goals.withinBudget(13, { maxOrdersPerGoal: 12 }), false);
  assert.strictEqual(goals.withinBudget(1, {}), true, 'an absent cap must not refuse everything');
  assert.strictEqual(goals.withinBudget(0, { maxOrdersPerGoal: 12 }), false, 'an empty plan is not a plan');
});

test('reconcile marks orphaned planning goals interrupted', () => {
  // A goal still `planning` on boot lost the PM agent that was decomposing it.
  const root = tmpRoot();
  const a = goals.create(root, { projectId: 'p', text: 'x' });
  const b = goals.create(root, { projectId: 'p', text: 'y' });
  goals.failPlanning(root, b.id, 'done already', 'raw');

  assert.strictEqual(goals.reconcile(root), 1);
  assert.strictEqual(goals.get(root, a.id).status, 'failed');
  assert.match(goals.get(root, a.id).error, /interrupted/);
  assert.strictEqual(goals.get(root, b.id).error, 'done already', 'settled goals are untouched');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'test/goals.test.js'`
Expected: FAIL — `Cannot find module '../lib/goals'`.

- [ ] **Step 3: Write the implementation**

Create `lib/goals.js`:

```js
'use strict';
const crypto = require('crypto');
const store = require('./store');

// What a human states. One goal fans out into many orders.
//
// This module owns the record and its lifecycle only: it knows nothing about
// agents, prompts or spawning. lib/plan.js drives it.
//
// Known limits:
// - Same cross-process race as every other record here: each goal is its own
//   file, so two writers collide only on the same goal.
// - `verified`/`rejected` verdicts and `supersedes` belong to plan 2c. A goal
//   reaches `running` when its orders are persisted and never leaves it in
//   this plan, because nothing yet watches them finish.

const SUB = 'goals';
const MAX_TEXT = 100000;
const SETTLED = new Set(['done', 'failed']);

function newId() {
  // Same scheme as orders: a sortable prefix, because createdAt is
  // millisecond-resolution and rapid pairs share a millisecond.
  const ms = String(Date.now()).padStart(14, '0');
  newId.tick = (newId.tick + 1) % 10000;
  return `goal-${ms}${String(newId.tick).padStart(4, '0')}-${crypto.randomUUID()}`;
}
newId.tick = 0;

function rel(id) {
  return `${SUB}/${id}.json`;
}

// Rejects rather than truncates. A shortened goal is a different goal that
// still reads plausibly, and the PM would decompose it with nobody the wiser.
function requiredText(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const s = value.trim();
  if (s.length > max) throw new Error(`${label} is too long (${s.length} > ${max})`);
  return s;
}

function create(root, input) {
  const src = input && typeof input === 'object' ? input : {};
  const goal = {
    id: newId(),
    projectId: requiredText(src.projectId, 'projectId', 200),
    text: requiredText(src.text, 'text', MAX_TEXT),
    status: 'planning',
    pmAgent: null,
    orderIds: [],
    error: null,
    // The PM's raw stdout, kept whether it parsed or not: when it did not,
    // this is the only evidence of what the prompt actually produced.
    rawPlan: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  store.writeJson(root, rel(goal.id), goal);
  return goal;
}

function get(root, id) {
  return store.readJson(root, rel(id), null);
}

function usable(g) {
  return !!g && typeof g === 'object' && !Array.isArray(g)
    && typeof g.id === 'string' && typeof g.createdAt === 'string';
}

function list(root, filter) {
  const f = filter || {};
  const all = store.list(root, SUB).map((id) => get(root, id)).filter(usable);
  const picked = f.projectId ? all.filter((g) => g.projectId === f.projectId) : all;
  return picked.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

// Every transition out of a live state goes through here, so the settled rule
// cannot be forgotten at a call site. reconcile() writes directly, because it
// must move goals INTO a settled state on boot.
function patch(root, id, changes) {
  const g = get(root, id);
  if (!g) return null;
  if (SETTLED.has(g.status)) return g;
  const next = { ...g, ...changes };
  store.writeJson(root, rel(id), next);
  return next;
}

function planned(root, id, { orderIds, pmAgent, rawPlan }) {
  return patch(root, id, {
    status: 'running',
    orderIds: Array.isArray(orderIds) ? orderIds.slice() : [],
    pmAgent: pmAgent || null,
    rawPlan: typeof rawPlan === 'string' ? rawPlan : null,
  });
}

// The PM could not produce a usable plan. Never retried: that is a prompt
// problem a human needs to see, and a silent retry hides it.
function failPlanning(root, id, error, rawPlan) {
  return patch(root, id, {
    status: 'failed',
    error: String(error),
    rawPlan: typeof rawPlan === 'string' ? rawPlan : null,
    finishedAt: new Date().toISOString(),
  });
}

// Spec 8a: a plan over the cap fails the goal whole. Truncating to the first N
// produces a half-executed goal that looks complete, and nothing signals the
// missing orders.
function withinBudget(count, budget) {
  if (!Number.isInteger(count) || count < 1) return false;
  const cap = (budget || {}).maxOrdersPerGoal;
  if (!Number.isFinite(cap) || cap < 1) return true;
  return count <= cap;
}

// On boot, a goal still `planning` lost the PM that was decomposing it.
function reconcile(root) {
  let n = 0;
  for (const g of list(root)) {
    if (g.status !== 'planning') continue;
    store.writeJson(root, rel(g.id), {
      ...g,
      status: 'failed',
      error: 'interrupted while planning',
      finishedAt: new Date().toISOString(),
    });
    n++;
  }
  return n;
}

module.exports = { create, get, list, planned, failPlanning, withinBudget, reconcile, newId, SETTLED };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test 'test/goals.test.js'` → 11 passing.
Then `node --test 'test/*.test.js'` → 225-ish. Report the real number.

- [ ] **Step 5: Mutation-verify the three rules that carry weight**

Apply each, confirm the **named** test fails, restore, confirm it passes. Report both outputs per mutant.

```bash
# M1: settled goals become rewritable
#   In patch(), delete: if (SETTLED.has(g.status)) return g;
#   Expect: "a settled goal is never rewritten" FAILS
# M2: an over-cap plan is truncated instead of refused
#   In withinBudget(), return true unconditionally
#   Expect: "withinBudget accepts a plan at the cap" FAILS
# M3: failPlanning discards the raw output
#   In failPlanning(), pass rawPlan: null always
#   Expect: "failPlanning records the reason and keeps the raw output" FAILS
```

- [ ] **Step 6: Commit**

```bash
git add lib/goals.js test/goals.test.js
git commit -F- <<'EOF'
feat(goals): the goal record and its lifecycle

What a human states, and the thing one PM run fans into many orders. Record and
transitions only - no agents, no prompts, no spawning.

Three rules are mutation-tested. A settled goal is never rewritten, the same
guard orders carries and for the same reason. An over-cap plan is refused
whole rather than truncated, because running the first twelve of a thirty-order
plan produces a half-executed goal that looks complete and nothing signals the
missing eighteen. And a failed planning run keeps the PM's raw output, since
that is the only evidence of what the prompt actually produced - a PM that
cannot make a plan is a prompt problem a human has to see, so it is never
silently retried.
EOF
```

---

## Task 3: The PM prompt and plan extraction

**Files:**
- Create: `lib/pm.js`
- Test: `test/pm.test.js`

Pure string work: build a prompt, and get a plan out of whatever an agent actually printed. No spawning, no store — so it can be table-tested against realistic and malformed transcripts.

- [ ] **Step 1: Write the failing test**

Create `test/pm.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const pm = require('../lib/pm');

test('the prompt states the goal, the project, and the required output shape', () => {
  const p = pm.buildPrompt({ text: 'make the tests green', projectPath: '/tmp/repo', maxOrders: 12 });
  assert.match(p, /make the tests green/);
  assert.match(p, /\/tmp\/repo/);
  assert.match(p, /12/, 'the cap must be stated, or the PM cannot respect it');
  assert.match(p, /title/);
  assert.match(p, /acceptance/);
});

test('a bare JSON array is extracted', () => {
  const r = pm.extractPlan('[{"title":"a","prompt":"do a","acceptance":"a is done"}]');
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders.length, 1);
  assert.strictEqual(r.orders[0].title, 'a');
});

test('a fenced block is extracted', () => {
  const out = 'Here is the plan:\n\n```json\n[{"title":"a","prompt":"p","acceptance":"x"}]\n```\n\nHope that helps!';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders.length, 1);
});

test('prose on both sides of a bare array is tolerated', () => {
  const out = 'I looked at the repo.\n[{"title":"a","prompt":"p","acceptance":"x"}]\nLet me know.';
  assert.strictEqual(pm.extractPlan(out).orders.length, 1);
});

test('the LAST plausible array wins', () => {
  // Agents commonly show a draft and then a corrected final answer. The last
  // one is the one they meant.
  const out = '[{"title":"draft","prompt":"p","acceptance":"x"}]\n\nOn reflection:\n' +
              '[{"title":"final","prompt":"p","acceptance":"x"}]';
  assert.strictEqual(pm.extractPlan(out).orders[0].title, 'final');
});

test('an array containing a brace inside a string is parsed correctly', () => {
  // Naive brace counting breaks here, and prompts are exactly the field most
  // likely to contain one.
  const out = '[{"title":"a","prompt":"run `if (x) { y }` and report","acceptance":"x"}]';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.match(r.orders[0].prompt, /\{ y \}/);
});

test('no JSON at all is an error, not an empty plan', () => {
  const r = pm.extractPlan('I would start by reading the README, then run the tests.');
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /no JSON plan/);
});

test('malformed JSON is an error naming the problem', () => {
  const r = pm.extractPlan('[{"title":"a",]');
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /no JSON plan/);
});

test('an entry missing a prompt is rejected, not defaulted', () => {
  // An order with no prompt would dispatch an agent with nothing to do, and
  // record it as succeeded when it exits 0.
  const r = pm.extractPlan('[{"title":"a","acceptance":"x"}]');
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /entry 0.*prompt/);
});

test('a non-array JSON value is rejected', () => {
  assert.match(pm.extractPlan('{"title":"a","prompt":"p"}').error, /no JSON plan/);
});

test('an empty array is rejected as not a plan', () => {
  assert.match(pm.extractPlan('[]').error, /empty/);
});

test('extra fields are dropped, not stored', () => {
  // The PM is an agent; whatever else it invents must not reach the record.
  const r = pm.extractPlan('[{"title":"a","prompt":"p","acceptance":"x","cwd":"/etc","agent":"rm"}]');
  assert.deepStrictEqual(Object.keys(r.orders[0]).sort(), ['acceptance', 'prompt', 'title']);
});

test('acceptance is optional and defaults to empty', () => {
  const r = pm.extractPlan('[{"title":"a","prompt":"p"}]');
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders[0].acceptance, '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'test/pm.test.js'`
Expected: FAIL — `Cannot find module '../lib/pm'`.

- [ ] **Step 3: Write the implementation**

Create `lib/pm.js`:

```js
'use strict';

// The PM prompt, and getting a plan out of whatever the agent actually
// printed. Pure: no spawning, no store, no filesystem - so it can be
// table-tested against real transcripts, including the malformed ones.

const MAX_TITLE = 200;
const MAX_TEXT = 100000;

function buildPrompt({ text, projectPath, maxOrders }) {
  return [
    `You are planning work for a software project at: ${projectPath}`,
    '',
    'READ the project to understand it. Do NOT modify any files - this is a',
    'planning pass only.',
    '',
    'The goal:',
    text,
    '',
    `Break this into AT MOST ${maxOrders} independent work orders. Fewer is`,
    'better. Each order will be executed by a separate agent that sees only',
    'that order, in its own copy of the repository, with no memory of the',
    'others - so each prompt must stand completely alone.',
    '',
    'Reply with ONLY a JSON array, no commentary before or after:',
    '',
    '[',
    '  {',
    '    "title": "short label",',
    '    "prompt": "the complete instruction for one agent, self-contained",',
    '    "acceptance": "how a reviewer will judge whether this order was done"',
    '  }',
    ']',
    '',
    'The acceptance criteria matter: another agent will later judge the result',
    'against them, and will not take the worker\'s own claim of success at',
    'face value. Make them checkable.',
  ].join('\n');
}

// Scan for balanced brackets while respecting string literals and escapes, so
// a brace inside a prompt does not break the extraction. Returns every
// top-level [...] span in the text.
function arraySpans(text) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  return spans;
}

function cleanEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { error: `entry ${index} is not an object` };
  }
  const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
  if (!prompt) return { error: `entry ${index} has no prompt` };
  if (prompt.length > MAX_TEXT) return { error: `entry ${index} prompt is too long` };
  const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, MAX_TITLE) : '';
  const acceptance = typeof entry.acceptance === 'string' ? entry.acceptance.trim().slice(0, MAX_TEXT) : '';
  // Exactly three fields reach the caller. The PM is an agent, and anything
  // else it invents - a cwd, an agent id - must not reach an order record.
  return { order: { title, prompt, acceptance } };
}

// Returns { orders, error }. Never throws: unparseable output is an outcome to
// record, and the raw text is retained by the caller either way.
function extractPlan(output) {
  const text = typeof output === 'string' ? output : '';
  const spans = arraySpans(text);
  // Last first: agents commonly show a draft and then a corrected final
  // answer, and the last one is the one they meant.
  for (let i = spans.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(spans[i]);
    } catch (_) {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    if (parsed.length === 0) return { orders: null, error: 'the PM returned an empty plan' };
    const orders = [];
    for (let n = 0; n < parsed.length; n++) {
      const r = cleanEntry(parsed[n], n);
      if (r.error) return { orders: null, error: r.error };
      orders.push(r.order);
    }
    return { orders, error: null };
  }
  return { orders: null, error: 'the PM returned no JSON plan' };
}

module.exports = { buildPrompt, extractPlan, arraySpans };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test 'test/pm.test.js'` → 13 passing.

- [ ] **Step 5: Mutation-verify the extraction rules**

```bash
# M1: naive brace counting
#   In arraySpans(), delete the inString handling
#   Expect: "an array containing a brace inside a string" FAILS
# M2: first array wins instead of last
#   Iterate spans forwards
#   Expect: "the LAST plausible array wins" FAILS
# M3: a missing prompt is defaulted
#   In cleanEntry(), return { order: { title, prompt: prompt || 'do the work', acceptance } }
#   Expect: "an entry missing a prompt is rejected" FAILS
# M4: extra fields pass through
#   Return { order: { ...entry } }
#   Expect: "extra fields are dropped" FAILS
```

- [ ] **Step 6: Commit**

```bash
git add lib/pm.js test/pm.test.js
git commit -F- <<'EOF'
feat(pm): the planning prompt, and getting a plan out of prose

Pure string work, deliberately free of spawning and persistence so it can be
table-tested against real transcripts - including the malformed ones, which is
the half that matters.

Extraction scans for balanced brackets while respecting string literals, since
a prompt is exactly the field most likely to contain a brace and naive counting
breaks on it. The last plausible array wins, because agents commonly show a
draft and then a corrected final answer. An entry with no prompt is refused
rather than defaulted: an order with nothing to do still dispatches an agent
and still records succeeded when it exits zero. And only title, prompt and
acceptance reach the caller - the PM is an agent, and whatever else it invents
must not reach an order record.
EOF
```

---

## Task 4: Run the PM and persist the plan

**Files:**
- Create: `lib/plan.js`
- Test: `test/plan.test.js`

The seam 2c's scheduler will call. Runs the PM through the existing `runner` in an isolated cwd — no second spawn path — and turns its output into persisted orders.

- [ ] **Step 1: Write the failing test**

Create `test/plan.test.js`:

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const plan = require('../lib/plan');
const goals = require('../lib/goals');
const orders = require('../lib/orders');
const projects = require('../lib/projects');

const created = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'skillspace-plan-'));
  created.push(d);
  return d;
}
function tmpGitRepo() {
  const d = tmpDir('skillspace-planrepo-');
  execSync('git init -q', { cwd: d });
  fs.writeFileSync(path.join(d, 'file.txt'), 'original\n');
  execSync('git add -A', { cwd: d });
  execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: d });
  return d;
}
function shimAgent(script) {
  const dir = tmpDir('skillspace-shim-');
  const bin = path.join(dir, 'fake-pm');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return { id: 'fake', bin, buildArgs: (p) => ['-p', p] };
}
after(() => {
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

const testEnv = () => ({ ...process.env });

const PLAN_OK = `#!/bin/sh
cat <<'JSON'
[{"title":"one","prompt":"do one","acceptance":"one is done"},
 {"title":"two","prompt":"do two","acceptance":"two is done"}]
JSON
exit 0
`;
const PLAN_PROSE = '#!/bin/sh\necho "I would start by reading the README."\nexit 0\n';
const PLAN_BIG = `#!/bin/sh
echo -n '['
i=0
while [ $i -lt 30 ]; do
  [ $i -gt 0 ] && echo -n ','
  echo -n '{"title":"t","prompt":"p","acceptance":"a"}'
  i=$((i+1))
done
echo ']'
exit 0
`;

test('a goal is decomposed into persisted orders', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'make it good' });

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
  });

  assert.strictEqual(result.status, 'running');
  assert.strictEqual(result.orderIds.length, 2);
  const first = orders.get(root, result.orderIds[0]);
  assert.strictEqual(first.goalId, goal.id);
  assert.strictEqual(first.seq, 0);
  assert.strictEqual(first.prompt, 'do one');
  assert.strictEqual(first.acceptance, 'one is done');
  assert.strictEqual(first.status, 'queued', 'this plan does not dispatch them');
  assert.strictEqual(orders.get(root, result.orderIds[1]).seq, 1);
});

test('the PM runs in an isolated worktree, not the project itself', async () => {
  // The PM is told not to modify anything, which is a hope, not a guarantee.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const agent = shimAgent(`#!/bin/sh\npwd > "${path.join(root, 'pm-cwd.txt')}"\n${PLAN_OK.split('\n').slice(1).join('\n')}`);

  await plan.decompose(root, { goal, project, agent, childEnv: testEnv });

  const cwd = fs.readFileSync(path.join(root, 'pm-cwd.txt'), 'utf8').trim();
  assert.notStrictEqual(cwd, fs.realpathSync(repo), 'the PM ran in the user\'s own tree');
  assert.match(cwd, /worktrees/);
});

test('the PM worktree is removed afterwards', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });

  await plan.decompose(root, { goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv });

  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], []);
});

test('unparseable output fails the goal and keeps the raw text', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_PROSE), childEnv: testEnv,
  });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /no JSON plan/);
  assert.match(result.rawPlan, /README/, 'the evidence of what the prompt produced was discarded');
  assert.strictEqual(orders.list(root, { projectId: project.id }).length, 0, 'no orders on a failed plan');
});

test('a plan over maxOrdersPerGoal fails the goal whole and dispatches nothing', async () => {
  // Spec 8a: running the first 12 of a 30-order plan produces a half-executed
  // goal that looks complete. The full plan is retained so the human can
  // narrow the goal and try again.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const base = projects.create(root, { path: repo });
  const project = { ...base, budget: { ...base.budget, maxOrdersPerGoal: 12 } };
  const goal = goals.create(root, { projectId: project.id, text: 'x' });

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_BIG), childEnv: testEnv,
  });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /30.*12|too many/);
  assert.match(result.rawPlan, /title/, 'the plan must be retained so it can be narrowed');
  assert.strictEqual(orders.list(root, { projectId: project.id }).length, 0);
});

test('an impossible cap fails the goal without spawning anything', async () => {
  // goals.withinBudget honours a numeric cap literally - 0 means none allowed,
  // not unlimited - so every plan would be refused. Spending a credentialed
  // agent run to discover that is the expensive path to a knowable answer.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const base = projects.create(root, { path: repo });
  const project = { ...base, budget: { ...base.budget, maxOrdersPerGoal: 0 } };
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const marker = path.join(root, 'pm-ran.txt');
  const agent = shimAgent(`#!/bin/sh\ntouch "${marker}"\nexit 0\n`);

  const result = await plan.decompose(root, { goal, project, agent, childEnv: testEnv });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /maxOrdersPerGoal is 0/);
  assert.ok(!fs.existsSync(marker), 'the PM was spawned for a cap that can never be satisfied');
});

test('a PM that exits non-zero fails the goal with its output', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const agent = shimAgent('#!/bin/sh\necho "model overloaded" >&2\nexit 3\n');

  const result = await plan.decompose(root, { goal, project, agent, childEnv: testEnv });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /exit(ed)? 3|exit code 3/);
  assert.match(result.rawPlan, /overloaded/);
});

test('a missing agent fails the goal without creating a worktree', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });

  const result = await plan.decompose(root, { goal, project, agent: null, childEnv: testEnv });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /agent/);
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], []);
});

test('a caller-supplied onChunk still receives the output', async () => {
  // Capturing internally must not steal the stream plan 3's live log needs.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  let seen = '';

  await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
    onChunk: (c) => { seen += c; },
  });

  assert.match(seen, /title/, 'the caller\'s onChunk was not called');
});

test('a header line already in the log does not reach the extractor', async () => {
  // The runner opens the log in append mode and a caller may have written a
  // header into it. Reading the file back would feed that to the extractor.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const goal = goals.create(root, { projectId: project.id, text: 'x' });
  const logFile = plan.logFileFor(root, goal.id);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, '=== header [{"title":"ghost","prompt":"p"}] ===\n');

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
  });

  assert.strictEqual(result.status, 'running');
  assert.strictEqual(result.orderIds.length, 2, 'a plan from the header leaked in');
  assert.strictEqual(orders.get(root, result.orderIds[0]).title, 'one');
});

test('a dir project plans in place and its files survive', async () => {
  const root = tmpDir('skillspace-home-');
  const work = tmpDir('skillspace-work-');
  fs.writeFileSync(path.join(work, 'keep.txt'), 'precious');
  const project = projects.create(root, { path: work });
  assert.strictEqual(project.kind, 'dir');
  const goal = goals.create(root, { projectId: project.id, text: 'x' });

  const result = await plan.decompose(root, {
    goal, project, agent: shimAgent(PLAN_OK), childEnv: testEnv,
  });

  assert.strictEqual(result.status, 'running');
  assert.ok(fs.existsSync(path.join(work, 'keep.txt')), 'a dir project must never be cleaned up');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'test/plan.test.js'`
Expected: FAIL — `Cannot find module '../lib/plan'`.

- [ ] **Step 3: Write the implementation**

Create `lib/plan.js`:

```js
'use strict';
const path = require('path');
const goals = require('./goals');
const orders = require('./orders');
const worktrees = require('./worktrees');
const runner = require('./runner');
const pm = require('./pm');

// Ten megabytes: far above any real plan, far below a runaway transcript.
const CAPTURE_CAP = 10 * 1024 * 1024;

// Runs the PM and turns what it says into persisted orders. This is the seam
// plan 2c's scheduler will call after a goal is created.
//
// The PM is spawned through the same runner as any other agent - one spawn
// path, one timeout, one process-group reap. It gets an isolated worktree for
// the same reason orders do: the prompt tells it not to modify anything, which
// is a hope rather than a guarantee, and a worktree makes it true.
//
// Known limits:
// - Orders are persisted `queued` and nothing dispatches them. That is plan
//   2c's scheduler; until then a human dispatches them individually through
//   POST /api/orders, which is the approval gate the spec's 9 says v1 lacks.
// - A dir project cannot be isolated, so the PM reads and could write the
//   user's own directory. Same limitation as an order on a dir project.

function logFileFor(root, goalId) {
  return path.join(root, 'logs', `${goalId}.log`);
}

async function decompose(root, { goal, project, agent, childEnv, onChunk }) {
  if (!agent) return goals.failPlanning(root, goal.id, 'no agent available', null);
  if (typeof childEnv !== 'function') {
    // Same contract as dispatch: refusing beats defaulting to process.env,
    // which is the credential leak the allowlist exists to prevent.
    return goals.failPlanning(root, goal.id, 'no child environment policy supplied', null);
  }

  // Refuse an impossible cap BEFORE spawning. goals.withinBudget treats a
  // numeric cap literally, so maxOrdersPerGoal: 0 refuses every plan - and
  // finding that out after a fifteen-minute credentialed agent run, having
  // asked it for "at most 0 work orders", is the expensive way to learn it.
  const cap = ((project && project.budget) || {}).maxOrdersPerGoal;
  if (Number.isFinite(cap) && cap < 1) {
    return goals.failPlanning(root, goal.id, `maxOrdersPerGoal is ${cap}: no plan can be accepted`, null);
  }

  let wt;
  try {
    wt = await worktrees.prepare(root, project, goal.id);
  } catch (e) {
    return goals.failPlanning(root, goal.id, e.message, null);
  }

  // Capture the PM's output as it streams rather than reading the log back
  // afterwards. The log is opened in append mode and a caller may have written
  // a header line into it, and an agent transcript has no size bound - reading
  // the file would inherit both problems. CAPTURE_CAP is generous next to any
  // real plan and small next to a runaway agent.
  let captured = '';
  let truncated = false;
  const capture = (chunk) => {
    if (captured.length < CAPTURE_CAP) {
      captured += chunk;
      if (captured.length > CAPTURE_CAP) {
        captured = captured.slice(0, CAPTURE_CAP);
        truncated = true;
      }
    } else {
      truncated = true;
    }
    if (onChunk) onChunk(chunk);
  };

  let result;
  try {
    const budget = (project && project.budget) || {};
    const maxOrders = Number.isFinite(budget.maxOrdersPerGoal) ? budget.maxOrdersPerGoal : 12;
    result = await runner.run({
      agent,
      prompt: pm.buildPrompt({ text: goal.text, projectPath: project.path, maxOrders }),
      cwd: wt.cwd,
      logFile: logFileFor(root, goal.id),
      timeoutMs: budget.orderTimeoutMs || 900000,
      env: childEnv(agent),
      onChunk: capture,
    });
  } finally {
    // The PM's worktree is discarded whatever happened. Unlike an order's, its
    // output is the plan on stdout, not the tree - there is nothing to
    // preserve, and keeping it would leave a branch per goal.
    await worktrees.cleanup(wt);
  }

  const raw = captured;
  if (truncated) {
    // A plan that overflowed the cap is almost certainly not a plan. Refusing
    // beats extracting from a half-transcript that happens to parse.
    return goals.failPlanning(root, goal.id, `the PM produced more than ${CAPTURE_CAP} bytes`, raw);
  }
  if (result.error) {
    return goals.failPlanning(root, goal.id, `pm ${result.error}`, raw);
  }
  if (result.exitCode !== 0) {
    return goals.failPlanning(root, goal.id, `pm exited ${result.exitCode}`, raw);
  }

  const { orders: entries, error } = pm.extractPlan(raw);
  if (error) return goals.failPlanning(root, goal.id, error, raw);

  const budget = (project && project.budget) || {};
  if (!goals.withinBudget(entries.length, budget)) {
    // Refused whole, never truncated, and the plan is kept so the human can
    // narrow the goal rather than guess what was dropped.
    return goals.failPlanning(
      root, goal.id,
      `the plan has ${entries.length} orders, over the limit of ${budget.maxOrdersPerGoal}`,
      raw
    );
  }

  const orderIds = entries.map((e, seq) => {
    const o = orders.create(root, {
      projectId: project.id,
      prompt: e.prompt,
      title: e.title,
      acceptance: e.acceptance,
    });
    orders.attachToGoal(root, o.id, goal.id, seq);
    return o.id;
  });

  return goals.planned(root, goal.id, { orderIds, pmAgent: agent.id, rawPlan: raw });
}

module.exports = { decompose, logFileFor };
```

- [ ] **Step 4: Add `attachToGoal` to `lib/orders.js`**

`orders.create` deliberately sets `goalId` and `seq` to `null` — Plan 2a reserved them. Add the one writer that fills them:

```js
// goalId and seq were reserved when the record shape was fixed, so that adding
// goals later would not change it under an already-persisted store. This is
// the writer that fills them; it runs once, immediately after create, before
// anything can settle the order.
function attachToGoal(root, id, goalId, seq) {
  return patch(root, id, { goalId: String(goalId), seq: Number(seq) });
}
```
Export it. Add to `test/orders.test.js`:

```js
test('attachToGoal fills the reserved fields', () => {
  const root = tmpRoot();
  const o = orders.create(root, { projectId: 'p', prompt: 'x' });
  assert.strictEqual(o.goalId, null);
  const linked = orders.attachToGoal(root, o.id, 'goal-1', 3);
  assert.strictEqual(linked.goalId, 'goal-1');
  assert.strictEqual(linked.seq, 3);
  assert.strictEqual(orders.get(root, o.id).goalId, 'goal-1');
});
```

- [ ] **Step 5: Run the tests**

Run: `node --test 'test/plan.test.js'` → 11 passing. Then `node --test 'test/orders.test.js'` → 26.
Then `node --test 'test/*.test.js'` — report the real number.

- [ ] **Step 6: Mutation-verify the ordering guarantees**

```bash
# M1: the budget check runs after the orders are created
#   Move the withinBudget block below the entries.map
#   Expect: "a plan over maxOrdersPerGoal fails the goal whole" FAILS on the
#           orders.list assertion - the orders exist
# M2: the PM runs in the project itself
#   Pass cwd: project.path instead of wt.cwd
#   Expect: "the PM runs in an isolated worktree" FAILS
# M3: cleanup only on success
#   Move the cleanup out of the finally, after the success path
#   Expect: "the PM worktree is removed afterwards" still passes (success),
#           so ALSO add a failing-PM case to that test and confirm it fails then
# M4: raw output discarded on a parse failure
#   Pass null instead of raw to failPlanning
#   Expect: "unparseable output fails the goal and keeps the raw text" FAILS
# M5: read the log back instead of capturing the stream
#   const raw = require('fs').readFileSync(result.logFile, 'utf8');
#   Expect: "a header line already in the log does not reach the extractor" FAILS
#   (this is the shape the plan itself got wrong first - the header's array is
#    LAST in the file only if the agent printed nothing, so confirm the test
#    fails for the RIGHT reason and say what it reported)
# M5b: the impossible-cap check moves below the spawn
#   Move the `cap < 1` block after the runner.run call
#   Expect: "an impossible cap fails the goal without spawning anything" FAILS
#   on the marker assertion - the goal still fails, but a credentialed agent ran
# M6: capture ignores the caller's onChunk
#   In capture(), drop the `if (onChunk) onChunk(chunk);` line
#   Expect: "a caller-supplied onChunk still receives the output" FAILS
```

M3 is the one to watch: if the existing test cannot distinguish, the test is not pinning the `finally` — fix the test, not the assertion, and say so.

- [ ] **Step 7: Commit**

```bash
git add lib/plan.js lib/orders.js test/plan.test.js test/orders.test.js
git commit -F- <<'EOF'
feat(plan): run the PM and persist what it planned

The PM goes through the same runner as any other agent - one spawn path, one
timeout, one process-group reap - and gets an isolated worktree for the same
reason orders do: the prompt tells it not to modify anything, which is a hope
rather than a guarantee.

Ordering is mutation-tested. The budget is checked before any order is created,
so a plan over the cap leaves nothing behind; the plan itself is retained so a
human can narrow the goal instead of guessing what was dropped. Unparseable
output keeps the PM's raw text, because that is the only evidence of what the
prompt produced.

Orders are persisted queued and nothing dispatches them. Until the scheduler
lands, a human reads the plan and dispatches its orders individually - which is
the approval gate the design says v1 does not have.

attachToGoal fills goalId and seq, reserved when the order record shape was
fixed precisely so that adding goals would not change it under an
already-persisted store.
EOF
```

---

## Task 5: Goal endpoints

**Files:**
- Create: `routes/goals.js`
- Modify: `server.js` (wire the module, add the boot reconcile)
- Test: `test/goals-api.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/goals-api.test.js`. Model the harness on `test/orders-api.test.js` — read it and reuse `startServer` (**`startServer(home, extraEnv)` takes two arguments**; passing a single options object silently sets neither and yields a vacuous pass) (including its `HOME`/`PATH` rig and the `/api/config` assertion), `freePort`, `tmp`, and `waitFor`. **The shim must live in `fakeHome/.local/bin` only**, never on `PATH`; that is what makes the rig able to observe which path spawned the agent.

Tests:

```js
test('POST /api/goals decomposes into queued orders', ...)
  // → 200, goal.status 'running', orderIds.length 2, each order queued with a
  //   goalId and a seq. Poll with waitFor until the goal leaves 'planning'.

test('POST /api/goals rejects an unknown project with 404', ...)

test('POST /api/goals rejects a missing text with 400, not 500', ...)

test('POST /api/goals returns immediately, without waiting for the PM', ...)
  // The PM run is bounded by orderTimeoutMs - up to fifteen minutes. Assert
  // the POST resolves in under 2000ms with status 'planning'.

test('GET /api/goals lists newest first and filters by project', ...)

test('GET /api/goals/:id returns the goal and its orders', ...)
  // → { goal, orders: [...] } so a reader does not need a second round trip.

test('an id that is not a plain identifier is refused with 400', ...)

test('POST /api/goals refuses a top-level navigation', ...)
  // Planning spawns a credentialed agent, so it carries the same guard as
  // /api/orders. RAW SOCKET, not fetch - undici overrides Sec-Fetch-Mode.

test('a PM that returns prose leaves the goal failed with its output readable', ...)

test('goals still planning are reconciled to failed on boot', ...)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'test/goals-api.test.js'`
Expected: FAIL — the routes do not exist, so `r.json()` throws on the catch-all's `not found`.

- [ ] **Step 3: Write the routes**

Create `routes/goals.js`, following `routes/orders.js`'s factory shape exactly:

```js
'use strict';
const projects = require('../lib/projects');
const goals = require('../lib/goals');
const orders = require('../lib/orders');
const planner = require('../lib/plan');

module.exports = (deps) => {
  const { root, sendJson, readBody, OVERSIZE, ABORTED, plainIdFrom,
          isTopLevelNavigation, denyNavigation, AGENTS, childEnv } = deps;

  return async ({ req, res, u, p }) => {
    if (p === '/api/goals' && req.method === 'GET') {
      const projectId = u.searchParams.get('project') || null;
      sendJson(res, 200, { goals: goals.list(root, projectId ? { projectId } : {}) });
      return true;
    }

    if (p === '/api/goals' && req.method === 'POST') {
      // Planning spawns a credentialed agent, so it carries the same guard as
      // creating an order: a link clicked in Slack must not start work.
      if (isTopLevelNavigation(req)) return denyNavigation(res, '/api/goals'), true;

      const body = await readBody(req);
      if (body[ABORTED]) return true;
      if (body[OVERSIZE]) { sendJson(res, 413, { error: 'request body too large' }); return true; }

      const project = projects.get(root, String(body.projectId || ''));
      if (!project) { sendJson(res, 404, { error: 'no such project' }); return true; }

      const requested = typeof body.agent === 'string' ? body.agent : '';
      const agent = requested ? AGENTS.find((a) => a.id === requested) : AGENTS[0];
      if (!agent) {
        sendJson(res, 400, {
          error: requested
            ? `未知的 agent：${requested}（可用：${AGENTS.map((a) => a.id).join(', ') || '无'}）`
            : '没有检测到可用的 agent',
        });
        return true;
      }

      let goal;
      try {
        goal = goals.create(root, { projectId: project.id, text: body.text });
      } catch (e) {
        const msg = String((e && e.message) || e);
        sendJson(res, /^\w+ (is required|is too long)/.test(msg) ? 400 : 500, { error: msg });
        return true;
      }

      // Planning without awaiting: the PM run is bounded by orderTimeoutMs,
      // up to fifteen minutes, so awaiting it would hold the connection for
      // the length of the run. The caller gets the planning record and polls.
      planner
        .decompose(root, { goal, project, agent, childEnv })
        .catch((e) => {
          console.error('[server] goal %s failed to plan:', goal.id, e.message);
          try { goals.failPlanning(root, goal.id, `plan: ${e.message}`, null); } catch (_) {}
        });

      sendJson(res, 200, { goal });
      return true;
    }

    const one = p.match(/^\/api\/goals\/([^/]+)$/);
    if (one && req.method === 'GET') {
      const id = plainIdFrom(res, one[1], 'goal id');
      if (id === null) return true; // already answered 400
      const goal = goals.get(root, id);
      if (!goal) { sendJson(res, 404, { error: 'no such goal' }); return true; }
      // The orders come with it: a reader always wants both, and a second
      // round trip would race the goal moving on.
      sendJson(res, 200, {
        goal,
        orders: goal.orderIds.map((oid) => orders.get(root, oid)).filter(Boolean),
      });
      return true;
    }

    return false;
  };
};
```

- [ ] **Step 4: Wire it in `server.js`**

Beside the other route factories:
```js
const goalRoutes = require('./routes/goals')(routeDeps);
```
In the handler, after the order routes:
```js
  if (await goalRoutes(rq)) return;
```
And beside the existing order reconcile, before `server.listen`:
```js
try {
  const n = goals.reconcile(SKILLSPACE_HOME);
  if (n) console.log(`  reconciled ${n} interrupted goal(s)`);
} catch (e) {
  console.warn('[server] could not reconcile goals:', e.message);
}
```
Add `const goals = require('./lib/goals');` with the other requires.

- [ ] **Step 5: Run the tests**

Run: `node --test 'test/goals-api.test.js'` → 10 passing.
Then `node --test 'test/*.test.js'` five times — report the range, not a single number. A single green run is what let earlier flakes through twice.

- [ ] **Step 6: Mutation-verify**

```bash
# M1: remove the navigation guard on POST → the raw-socket test FAILS
# M2: await the decompose → "returns immediately" FAILS (takes the PM's runtime)
# M3: remove the boot reconcile → the reconciliation test FAILS
# M4: silently substitute AGENTS[0] for an unknown agent → the unknown-agent test FAILS
# M5: GET /api/goals/:id returns the goal without its orders → that test FAILS
```

- [ ] **Step 7: Commit**

```bash
git add server.js routes/goals.js test/goals-api.test.js
git commit -F- <<'EOF'
feat(api): goal endpoints

POST creates a goal and starts the PM without awaiting it: the planning run is
bounded by orderTimeoutMs, up to fifteen minutes, so awaiting it would hold the
connection for the length of the run. The caller gets the planning record and
polls.

Planning spawns a credentialed agent, so POST carries the same navigation guard
as creating an order, and an unrecognised agent id is a 400 rather than a
silent substitution - the goal record persists pmAgent as though it were what
was asked for.

GET /api/goals/:id returns the orders alongside the goal, because a reader
always wants both and a second round trip would race the goal moving on.

On boot, a goal still planning lost the PM that was decomposing it and is
reconciled to failed rather than assumed to have produced a plan.
EOF
```

---

## Self-review

**Spec coverage.** §3 Goal — Task 2, including `pmAgent` and `orderIds`; `verified`/`rejected` remain stored-but-unset, which is 2c. §4 flow — Tasks 3 and 4 cover human states goal → PM dispatched with cwd = an isolated copy of the project → JSON plan → orders persisted `queued`. The remaining arrows (scheduler dispatches, PM re-dispatched per result, verdict recorded) are 2c by design. §4's *"If the PM returns unparseable output, the goal goes to failed with the raw output retained. It is never silently retried"* — Task 4, mutation-tested. §8a `maxOrdersPerGoal` — Tasks 2 and 4, refused whole with the plan retained, asserting nothing was created. §10's boot reconciliation — Tasks 2 and 5.

**Gap I am recording rather than fixing:** the spec's §4 says the PM runs with *"cwd = project path, read-only intent"*. This plan runs it in an isolated worktree instead, because read-only intent is unenforceable — a prompt cannot stop an agent writing. For a `git` project that is strictly safer and the PM still sees the whole tree. For a `dir` project it is identical to the spec, and identically unprotected. Recorded in `lib/plan.js`'s `Known limits:`.

**Type consistency.** `goals.planned(root, id, { orderIds, pmAgent, rawPlan })` is called that way in Task 4. `goals.failPlanning(root, id, error, rawPlan)` — four positional arguments — likewise. `pm.extractPlan(text)` returns `{ orders, error }` where `orders` is `null` on failure, and Task 4 destructures exactly that. `orders.attachToGoal(root, id, goalId, seq)` is defined in Task 4 Step 4 and used in Step 3 — note the ordering in the task, which is deliberate so the test written first fails for the right reason. `plan.decompose(root, { goal, project, agent, childEnv, onChunk })` takes `childEnv` as a **function**, matching `dispatch.runOrder`'s contract, and refuses rather than defaulting.

**Placeholder scan:** no TBDs; every code step carries real code; every command carries an expected result.

---

## What this plan does not do

- **No scheduler.** Orders are persisted `queued` and a human dispatches them individually through 2a's `POST /api/orders`. That is 2c.
- **No verdicts.** `verified` and `rejected` stay unset; nothing judges an order against its `acceptance` yet.
- **No `supersedes`.** A rejected order spawning a replacement is 2c.
- **No UI.** Goals are API-only until Plan 3.
- **No approval gate as a feature** — the absence of the scheduler *is* the gate, and it disappears when 2c lands. If the gate turns out to be worth keeping, that is a decision to make in 2c, not a property to rely on afterwards.
