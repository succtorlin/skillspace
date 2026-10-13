# The Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A goal's orders run themselves — up to the project's concurrency, without a human dispatching each one by id.

**Architecture:** One new module, `lib/scheduler.js`, holding a poll loop that asks the existing guards rather than duplicating them: `dispatch.atCapacity()` for the global ceiling, `dispatch.projectBusy()` for unisolated projects, and `dispatch.runOrder`'s own refusals as the authority. Every check the scheduler makes is advisory — it exists to avoid pointless work, never to be the bound. Three carried-forward defects land first, because the scheduler is what makes them reachable.

**Tech Stack:** Plain Node 24, zero runtime dependencies, `node:test`, no framework, no build step. Builds on Plans 2a and 2b (`lib/{store,projects,orders,worktrees,runner,dispatch,goals,pm,plan}.js`, `routes/{projects,orders,goals,common,deps}.js`).

---

## Scope of this plan

Plan 2's remaining design work splits the same way 2a/2b did, and for the same reason: 2b was five tasks, sixteen commits and ten gates, and its own text carried eleven errors.

| | Scope | Ships |
|---|---|---|
| **2c — this plan** | The scheduler loop, plus the four deferred defects it makes reachable | A goal's orders execute automatically, bounded by concurrency and by spend |
| **2d — next** | §4 verdicts (`verified` \| `rejected`), `supersedes`, `POST /api/orders/:id/retry` | The PM judges each result against its `acceptance`, and a rejected order can be superseded |
| **3** | §8 board + order drawer, live log streaming | Watch it happen |

**Why the scheduler first.** Verdicts need completed orders, which exist today either way — a human can already dispatch by id. But the scheduler is where four of 2b's seven deferred items land, and every one of them is a concurrency defect that only becomes reachable when something drives concurrency up. Building verdicts first would mean building them on a foundation with a known worktree race and no claimed-id query.

**Deferred out of this plan, deliberately:**

- **Worktree GC** (2b item 5). Leaked directories after a SIGKILL are never reclaimed — `reconcile` is record-only, and since ids never repeat, `prepare`'s non-empty guard never fires. A correct sweep must **preserve then remove** (reusing `cleanup`'s commit-to-branch path), decide what "settled" means for a goal versus an order, and handle a registration whose directory is already gone. That is a feature with its own tests, and the scheduler does not make it worse. Record it; do not build it here.
- **Verdicts and `supersedes`** — 2d, per the table above.

## File structure

| File | Responsibility | Approx |
|---|---|---|
| `lib/scheduler.js` | The poll loop: pick runnable orders, dispatch, never be the bound. | 200 |
| `lib/worktrees.js` | +per-repo mutex around `git worktree add` (Task 2). | +40 |
| `lib/dispatch.js` | +`isClaimed(id)` (Task 1). | +15 |
| `lib/goals.js` | +the real state vocabulary and its migration read (Task 3). | +45 |
| `routes/orders.js` | +409 on a double-dispatch (Task 1). | +8 |
| `routes/scheduler.js` | `GET /api/scheduler` — is it running, what did it last do. | 70 |
| `server.js` | Wiring only: start after boot reconcile, stop before `cancelAll`. | +20 |
| `package.json` | `engines.node` → `">=21"`. | 1 |
| `test/{scheduler,scheduler-api}.test.js` + additions | | 800 |

**`server.js` is 1220 lines against this repo's 800 ceiling**, and a `/code-review` run flagged it as HIGH. The scheduler must not land there — hence `lib/scheduler.js` and `routes/scheduler.js`, with `server.js` taking wiring only.

---

## Standing questions for every task in this plan

Executing Plan 2b found **eleven errors in the plan text itself**, all mine, none found by reading. Carry these as questions, not as trivia:

1. **Does this test actually pin the thing it names?** Four times a prescribed test could not fail for its prescribed mutant; twice that left the suite green over a live bug. If a mutant survives, **the test is wrong, not the mutant** — add the one that kills it and say so.
2. **Does this fixture's input reach the path it names?** `echo -n` emitted a literal `-n` and an over-budget test passed on "no JSON plan"; ANSI escapes swallowed an entire plan because `ESC[32m` contains a `[`. A green test proving nothing is worse than a missing one.
3. **Does this fallback stop enforcing what the function exists to enforce?** Four times a permissive default silently disabled a limit — a missing `maxConcurrentRuns` removed the process ceiling; `maxOrdersPerGoal: 0` read as unlimited. **Fail closed.**
4. **Does this comment assert a guarantee the code provides?** Found in three of five 2b tasks. `RUNNING` "needed for shutdown" that shutdown never read; a ceiling gate that "stops a held-down button" and didn't.
5. **What has my closest sibling already paid for that I have not inherited?** `goals.js` missed four of `orders.js`'s guards; `plan.js` missed four of `dispatch.js`'s. **`lib/scheduler.js`'s sibling is `lib/dispatch.js`** — read it for its scars, not its shape.
6. **Was my control run green before I trusted that mutation verdict?** A mutant scored against an already-failing test reads as a **KILL** while proving nothing.

---

## Task 1: A claimed-id query, and the housekeeping that blocks nothing

**Files:**
- Modify: `lib/dispatch.js`, `routes/orders.js`, `package.json`
- Test: `test/dispatch.test.js`, `test/orders-api.test.js`

Two small things the scheduler needs, plus a one-line packaging fix. Doing them first keeps Task 4 focused on the loop.

- [ ] **Step 1: Write the failing tests**

Add to `test/dispatch.test.js`:

```js
test('isClaimed reports whether an id holds a slot right now', async () => {
  // The scheduler needs to know "is THIS order already in flight" without
  // asking projectBusy, which is true for every git order on the project and
  // would therefore refuse orders that are perfectly safe to run.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'SLOW-AGENT one' });

  assert.strictEqual(dispatch.isClaimed(order.id), false, 'not claimed before dispatch');
  const running = dispatch.runOrder(root, {
    order, project, agent: shimAgent(SLOW), childEnv: testEnv,
  });
  assert.strictEqual(dispatch.isClaimed(order.id), true, 'the claim is synchronous');
  dispatch.cancel(order.id);
  await running;
  assert.strictEqual(dispatch.isClaimed(order.id), false, 'released when it settles');
});

test('isClaimed is false for an id that does not exist', () => {
  assert.strictEqual(dispatch.isClaimed('ord-nope'), false);
  assert.strictEqual(dispatch.isClaimed(null), false);
  assert.strictEqual(dispatch.isClaimed(undefined), false);
});
```

Add to `test/orders-api.test.js`:

```js
test('dispatching an order twice tells the second caller it was refused', async () => {
  // Both POSTs land inside runOrder's claim window, both read `queued`, and
  // before this the second got a 200 while its dispatch was silently refused
  // by runOrder's own `already dispatched` guard. The order was never run
  // twice; the caller was just told the wrong thing.
  const s = await startServer(tmp('skillspace-double-'), {});
  try {
    const p = await makeProjectOn(s.base, { git: true });
    const created = await postJson(`${s.base}/api/orders`, { projectId: p.id, prompt: 'SLOW-AGENT x' });
    assert.strictEqual(created.status, 200);
    const id = created.body.order.id;

    const [a, b] = await Promise.all([
      postJson(`${s.base}/api/orders/${id}/dispatch`, {}),
      postJson(`${s.base}/api/orders/${id}/dispatch`, {}),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepStrictEqual(codes, [200, 409], `both callers got ${codes}`);
    const refused = a.status === 409 ? a : b;
    assert.match(refused.body.error, /already/, 'the 409 must say why');
  } finally {
    await stopServer(s);
  }
});
```

`postJson`, `startServer`, `stopServer`, `makeProjectOn` already exist in that file — **read them rather than assuming their signatures**. `startServer(home, extraEnv)` takes **two** arguments; a single options object silently sets neither and yields a vacuous pass.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test 'test/dispatch.test.js' 'test/orders-api.test.js'`
Expected: FAIL — `dispatch.isClaimed is not a function`, and the double-dispatch returns `[200, 200]`.

**Node 24 requires the quoted glob** — `node --test test/` fails, because Node ≥23 treats positional args as file paths.

- [ ] **Step 3: Add `isClaimed`**

In `lib/dispatch.js`, beside `projectBusy`:

```js
// Is this specific order in flight right now? The scheduler needs this and
// projectBusy cannot stand in: projectBusy is true for EVERY git order on the
// project, so a scheduler using it would refuse orders that are perfectly safe
// to run in their own worktrees.
//
// Advisory, like every other pre-check: the authority is the synchronous claim
// inside runOrder. A caller that skips this is refused there, not here.
function isClaimed(orderId) {
  return typeof orderId === 'string' && inFlight.has(orderId);
}
```
Export it.

- [ ] **Step 4: Return 409 on a double-dispatch**

In `routes/orders.js`'s dispatch route, after the queued-state check and **before** `dispatch.runOrder`:

```js
      // runOrder refuses a second dispatch itself, but it does so
      // asynchronously inside a promise this route does not await - so the
      // second caller used to get a 200 for work that never ran.
      if (dispatch.isClaimed(id)) {
        sendJson(res, 409, { error: 'order is already being dispatched' });
        return true;
      }
```

This closes the window for HTTP callers only, because there is no `await` between this check and `runOrder`'s synchronous claim. It is not a lock — say so in the comment.

- [ ] **Step 5: Fix the engines floor**

In `package.json`:
```json
  "engines": {
    "node": ">=21"
  },
```
The test script is `node --test "test/**/*.test.js"`, and Node's test-runner glob support landed in **v21**. On the declared floor of 18 the pattern is treated as a literal path and `npm test` finds nothing — the branch that added the test script is what made the declared floor wrong.

- [ ] **Step 6: Run both suites**

Run: `node --test 'test/dispatch.test.js' 'test/orders-api.test.js'` — both green.
Then `node --test 'test/*.test.js'` — report the real count.

- [ ] **Step 7: Mutation-verify**

```bash
# M1: isClaimed always false
#   Expect: "dispatching an order twice…" FAILS with [200,200]
# M2: isClaimed drops the typeof guard, `inFlight.has(orderId)` alone
#   Expect: "isClaimed is false for an id that does not exist" — check whether
#   it actually fails. A Map.has(null) is false anyway, so this may be an
#   EQUIVALENT mutant. If so, ARGUE it, do not chase it, and say so in the code.
# M3: the 409 moves BELOW runOrder
#   Expect: the double-dispatch test FAILS (or becomes racy — if it still
#   passes, the test is timing-dependent and needs fixing, not the mutant)
```

- [ ] **Step 8: Commit**

```bash
git add lib/dispatch.js routes/orders.js package.json test/dispatch.test.js test/orders-api.test.js
git commit -F- <<'EOF'
feat(dispatch): a claimed-id query, and the 409 it makes possible

The scheduler needs to know whether one specific order is in flight, and
projectBusy cannot answer that - it is true for every git order on the project,
so a scheduler keying off it would refuse orders that are safe to run in their
own worktrees.

That query also closes a wrong answer at the HTTP layer: two dispatches of the
same order both read `queued`, both got 200, and one of them was silently
refused by runOrder's own guard. The order never ran twice; the second caller
was just told it had. There is no await between the new check and runOrder's
synchronous claim, so the window is closed for HTTP callers - it is not a lock,
and the comment says so.

Also corrected engines.node, which said >=18 while the test script needs Node
21 for test-runner glob support. The commit that added that script is what made
the declared floor wrong; on 18, npm test finds no tests at all.
EOF
```

---

## Task 2: A per-repo mutex around `git worktree add`

**Files:**
- Modify: `lib/worktrees.js`
- Test: `test/worktrees.test.js`

The scheduler is what drives concurrency up, so this lands before it.

- [ ] **Step 1: Write the failing test**

Add to `test/worktrees.test.js`:

```js
test('concurrent prepares on one repo do not race git', async () => {
  // Measured before this: `git worktree add` on one repo fails
  // probabilistically at any K>=2 - 1/12 trials at K=4, the shipped
  // MAX_CONCURRENT_RUNS default, under load - with
  //   fatal: failed to read .git/worktrees/<id>/commondir: Undefined error: 0
  // because one add enumerates .git/worktrees/*/commondir while another is
  // mid-creation of its own. It fails closed, so the cost is a legitimate
  // order failing spuriously.
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });

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
  // The real point: N DISTINCT worktrees, not N attempts that collapsed.
  const cwds = new Set(results.map((r) => r.wt.cwd));
  assert.strictEqual(cwds.size, N, 'prepares collided onto one cwd');

  for (const r of results) await worktrees.cleanup(r.wt);
});

test('the mutex is per repo, not global', async () => {
  // A global lock would serialise unrelated projects, turning an isolation fix
  // into a throughput bug. Two different repos must overlap.
  const root = tmpDir('skillspace-home-');
  const a = projects.create(root, { path: tmpGitRepo() });
  const b = projects.create(root, { path: tmpGitRepo() });

  const order = [];
  const slow = worktrees.prepare(root, a, 'ord_repo_a').then((wt) => { order.push('a'); return wt; });
  const fast = worktrees.prepare(root, b, 'ord_repo_b').then((wt) => { order.push('b'); return wt; });
  const [wa, wb] = await Promise.all([slow, fast]);

  assert.strictEqual(order.length, 2);
  assert.notStrictEqual(wa.cwd, wb.cwd);
  // Both repos have exactly one worktree each - neither waited on the other's
  // lock in a way that produced a shared queue.
  await worktrees.cleanup(wa);
  await worktrees.cleanup(wb);
});
```

**Before trusting the first test, verify it can fail.** Run it against the unmutexed code repeatedly — the race is probabilistic, so a single green run proves nothing. If you cannot make it fail in, say, 20 runs at N=8, **raise N until you can, and report the number you needed.** A test for a probabilistic fault that never observes the fault is exactly failure shape (2) from the standing questions.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'test/worktrees.test.js'` repeatedly.
Expected: intermittent FAIL with `failed to read .git/worktrees/…/commondir`. **Record how many runs it took.**

- [ ] **Step 3: Implement the mutex**

In `lib/worktrees.js`:

```js
// One `git worktree add` at a time per repository. Two concurrent adds on one
// repo race: one enumerates .git/worktrees/*/commondir while the other is
// mid-creation of its own, and reads a file that exists but is not yet
// written. Measured at 1/12 trials at K=4 - the shipped MAX_CONCURRENT_RUNS
// default - under load.
//
// Keyed by the repo path, NOT global: a global lock would serialise unrelated
// projects, which turns an isolation fix into a throughput bug.
//
// Known limits: this is a per-PROCESS lock. A second SkillSpace against the
// same repo still races, and so does a human running `git worktree add` by
// hand. Both are out of scope for a single-process localhost tool, and both
// still fail closed.
const addLocks = new Map();

function withRepoLock(repoPath, fn) {
  const prev = addLocks.get(repoPath) || Promise.resolve();
  // Chain onto the previous holder, swallowing its rejection so one failed
  // prepare cannot poison every later one on the same repo.
  const mine = prev.then(fn, fn);
  // Keep the chain finite: drop the entry once this is the tail.
  const done = mine.then(
    (v) => { if (addLocks.get(repoPath) === done) addLocks.delete(repoPath); return v; },
    (e) => { if (addLocks.get(repoPath) === done) addLocks.delete(repoPath); throw e; }
  );
  addLocks.set(repoPath, done);
  return done;
}
```

In `prepare`, wrap **only** the `git worktree add` call — not the whole function. Everything before it is read-only inspection, and holding the lock across the whole prepare would serialise more than the race requires.

- [ ] **Step 4: Run the tests**

Run: `node --test 'test/worktrees.test.js'` — **at least 20 times**, since you are proving the absence of a probabilistic fault. Report the count.
Then `node --test 'test/*.test.js'`.

- [ ] **Step 5: Mutation-verify**

```bash
# M1: mutex removed entirely
#   Expect: "concurrent prepares on one repo do not race git" FAILS
#   (probabilistically - run it as many times as step 2 needed)
# M2: mutex keyed globally instead of by repo path
#   const prev = addLocks.get('GLOBAL') || ...
#   Expect: "the mutex is per repo, not global" FAILS.
#   NOTE: if it does NOT fail, your second test is not pinning what it names -
#   a global lock still COMPLETES both prepares, just serially. Fix the test to
#   observe overlap (timestamps around the add, or a barrier) rather than
#   completion, and say so.
# M3: the lock wraps the whole prepare rather than the add
#   Expect: probably EQUIVALENT for correctness. Argue it; do not chase it.
```

M2 is the one to watch. As written, that test may well pass under a global lock — **which would make it failure shape (1) from the standing questions.**

- [ ] **Step 6: Commit**

```bash
git add lib/worktrees.js test/worktrees.test.js
git commit -F- <<'EOF'
fix(worktrees): serialise `git worktree add` per repository

Two concurrent adds on one repo race - one enumerates
.git/worktrees/*/commondir while the other is mid-creation of its own - and
fail with "Undefined error: 0". Measured at 1/12 trials at K=4, the shipped
MAX_CONCURRENT_RUNS default, under load; the previously recorded "out of reach
below K=4" was measured with too few trials to distinguish from noise.

Keyed by repo path rather than globally, because a global lock would serialise
unrelated projects and turn an isolation fix into a throughput bug. Only the
add is inside the lock; the inspection before it is read-only.

The scheduler is what makes this reachable in normal use, so it lands first.
EOF
```

---

## Task 3: What `running` means once something owns the transition

**Files:**
- Modify: `lib/goals.js`
- Test: `test/goals.test.js`

`goals.planned()` sets `running` at plan-persist time, `reconcile` deliberately skips `running`, and nothing else moves it. Twenty planned goals read as twenty running goals with zero agents alive. 2b left this deliberately, because the value is **persisted on disk** and 2c is the change that introduces a real distinction.

- [ ] **Step 1: Write the failing test**

Add to `test/goals.test.js`:

```js
test('a planned goal is `planned`, not `running`', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  const done = goals.planned(root, g.id, { orderIds: ['ord-a'], pmAgent: 'claude', rawPlan: '[]' });
  assert.strictEqual(done.status, 'planned', 'a plan on disk is not work in progress');
});

test('a goal already persisted as `running` reads as `planned`', () => {
  // The old value is on disk in every store that ran plan 2b. Rewriting those
  // records on read would be a migration this tool has no mechanism for, and
  // rewriting them on WRITE is impossible - `running` was never settled, but
  // patch() would have to touch every record to find them.
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'goals', `${g.id}.json`), 'utf8'));
  fs.writeFileSync(
    path.join(root, 'goals', `${g.id}.json`),
    JSON.stringify({ ...raw, status: 'running', orderIds: ['ord-a'] })
  );
  assert.strictEqual(goals.get(root, g.id).status, 'planned', 'a legacy record was not translated');
  assert.strictEqual(goals.list(root)[0].status, 'planned', 'list must translate too');
});

test('running means at least one of its orders is in flight', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  goals.planned(root, g.id, { orderIds: ['ord-a', 'ord-b'], pmAgent: 'claude', rawPlan: '[]' });
  const run = goals.markRunning(root, g.id);
  assert.strictEqual(run.status, 'running');
  // and it can go back: the last order settled, more remain queued
  assert.strictEqual(goals.markPlanned(root, g.id).status, 'planned');
});

test('a goal is done when every order it names has settled', () => {
  const root = tmpRoot();
  const g = goals.create(root, { projectId: 'p', text: 'x' });
  goals.planned(root, g.id, { orderIds: ['ord-a'], pmAgent: 'claude', rawPlan: '[]' });
  const done = goals.markDone(root, g.id);
  assert.strictEqual(done.status, 'done');
  assert.ok(done.finishedAt, 'a settled goal records when');
  // done is SETTLED, so nothing walks it back
  assert.strictEqual(goals.markRunning(root, g.id).status, 'done');
});

test('reconcile still skips a goal with work outstanding', () => {
  // `planned` and `running` both mean "orders exist that nothing has finished".
  // Sweeping either on boot would fail goals whose orders are fine.
  const root = tmpRoot();
  const a = goals.create(root, { projectId: 'p', text: 'a' });
  goals.planned(root, a.id, { orderIds: ['ord-a'], pmAgent: 'c', rawPlan: '[]' });
  const b = goals.create(root, { projectId: 'p', text: 'b' });  // still `planning`

  assert.strictEqual(goals.reconcile(root), 1, 'only the planning goal is swept');
  assert.strictEqual(goals.get(root, a.id).status, 'planned');
  assert.strictEqual(goals.get(root, b.id).status, 'failed');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test 'test/goals.test.js'`
Expected: FAIL — `planned` still returns `running`; `markRunning`/`markPlanned`/`markDone` do not exist.

- [ ] **Step 3: Implement**

In `lib/goals.js`:

```js
// The states, and what each one actually claims:
//
//   planning  the PM is decomposing. Swept on boot - nothing survives a
//             restart mid-decomposition.
//   planned   a plan is on disk and orders exist. NOT work in progress: this
//             is what `running` used to mean, which made twenty planned goals
//             read as twenty running ones with zero agents alive.
//   running   at least one of this goal's orders is in flight right now.
//   done      every order this goal names has settled.        [SETTLED]
//   failed    the PM could not produce a usable plan.         [SETTLED]
//
// `planned` and `running` both mean work is outstanding, which is why
// reconcile() sweeps neither.
const SETTLED = new Set(['done', 'failed']);

// Records written by plan 2b carry `running` for what is now `planned`. They
// are translated on READ rather than migrated: this tool has no migration
// mechanism, and a legacy record is indistinguishable from a current one
// except by this exact value.
//
// Known limits: a 2b-era goal whose orders genuinely WERE in flight also reads
// as `planned` after a restart. That is correct anyway - the agents died with
// the process.
function translate(g) {
  if (!g || g.status !== 'running' || g.legacy === false) return g;
  return { ...g, status: 'planned' };
}
```

Apply `translate` in `get()` and in `list()`'s map. `markRunning`, `markPlanned` and `markDone` all go through the existing private `patch()`, so the settled rule cannot be forgotten.

**Careful:** the translate-on-read must not make `markRunning` unobservable. `markRunning` writes `running` and `get` translates `running` → `planned`, which would undo it. Distinguish the two — a `legacy` flag written by `markRunning`, a separate field, or a different stored value. **Pick one, and write a test that fails if the distinction collapses.** This is exactly the shape that produces a comment asserting a guarantee the code does not provide.

- [ ] **Step 4: Run the tests**

Run: `node --test 'test/goals.test.js'` then the full suite.

- [ ] **Step 5: Mutation-verify**

```bash
# M1: planned() writes 'running' again    → "a planned goal is `planned`" FAILS
# M2: translate() removed                 → the legacy test FAILS
# M3: translate applied in get but not list → the list half of the legacy test FAILS
# M4: reconcile sweeps `planned` too      → "reconcile still skips a goal with
#     work outstanding" FAILS
# M5: markDone omits finishedAt           → the done test FAILS
```

- [ ] **Step 6: Commit**

```bash
git add lib/goals.js test/goals.test.js
git commit -F- <<'EOF'
feat(goals): states that mean what they say

`running` was set when the plan hit disk, so twenty planned goals read as
twenty running goals with zero agents alive, and nothing ever moved them -
reconcile skips `running` deliberately, and no other writer existed.

Now: planned means a plan exists, running means an order of this goal is in
flight, done means all of them settled. Plan 2b left this alone on purpose,
because the value is persisted and 2c is the change that introduces a real
distinction to name.

Records written by 2b are translated on read rather than migrated. There is no
migration mechanism here, and a legacy record is indistinguishable from a
current one except by this exact value.
EOF
```

---

## Task 4: The scheduler

**Files:**
- Create: `lib/scheduler.js`
- Test: `test/scheduler.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler.test.js`. Model the harness on `test/dispatch.test.js` — **read it and reuse its `tmpDir`, `tmpGitRepo`, `shimAgent`, `testEnv` helpers** rather than writing new ones.

The behaviours to pin, each with the mutant that must kill it:

```js
test('a goal\'s queued orders run without anyone dispatching them', ...)
  // start() → poll until both orders settle. Mutant: tick() does nothing.

test('the scheduler never exceeds the global ceiling', ...)
  // MAX=1, six queued orders across SIX DISTINCT GIT PROJECTS, ps-verified
  // peak. Mutant: the atCapacity check removed.
  // NOTE: distinct git projects, not one dir project - a dir project is
  // serialised by projectBusy and would pass with the ceiling check gone.
  // That is failure shape (2): an input that cannot reach the path it names.

test('a dir project gets one order at a time', ...)
  // Mutant: the projectBusy check removed. Assert ONE agent in the tree.

test('a settled order does not mean the project is claimable', ...)
  // projectOf.delete runs AFTER worktrees.cleanup, so a scheduler keying off
  // record status dispatches into a project still held. Mutant: poll
  // `order.status` instead of dispatch.projectBusy().

test('an order already claimed is not dispatched again', ...)
  // Mutant: the isClaimed check removed.

test('the scheduler stops cleanly and starts nothing after stop()', ...)
  // Mutant: stop() clears the timer but not the in-flight guard.

test('a tick that throws does not kill the loop', ...)
  // Make orders.list throw once. The next tick must still run - a poll loop
  // that dies silently is indistinguishable from one that has no work.

test('per-goal spend is bounded', ...)
  // Mutant: the budget check removed.
```

**Write these out in full.** Every one needs a named mutant that kills it, and every fixture must reach the path the test names.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test 'test/scheduler.test.js'`
Expected: FAIL — `Cannot find module '../lib/scheduler'`.

- [ ] **Step 3: Implement**

Create `lib/scheduler.js`. The shape:

```js
'use strict';
const orders = require('./orders');
const goals = require('./goals');
const projects = require('./projects');
const dispatch = require('./dispatch');

// Runs a goal's orders without a human dispatching each one.
//
// EVERY check here is advisory. The authority is the synchronous claim inside
// dispatch.runOrder, and these exist only to avoid pointless work - picking an
// order that will certainly be refused, or spawning past a ceiling. A caller
// that skips the scheduler entirely is bounded exactly as well.
//
// A poll loop rather than an event: a settled order does NOT mean its project
// is claimable, because dispatch releases the project claim in a finally that
// runs after worktrees.cleanup. Anything driven by "order settled" therefore
// dispatches into a project still held. Polling projectBusy is what that costs.
//
// Known limits:
// - The tick is O(orders). lib/orders' list() reads every record, so this is
//   the second caller that wants the index it already wants.
// - Nothing here retries a FAILED order. A goal with a failed order stays
//   short one order forever; retry arrives with supersedes in plan 2d.
```

Requirements, each of which a test above pins:

- `start(root, { intervalMs, childEnv, agentFor })` and `stop()`. `childEnv` **required, never defaulted** — the only sensible default is `process.env`, which is precisely the credential leak the allowlist exists to prevent. `dispatch.js` and `plan.js` both learned this; inherit it.
- One tick at a time. A tick that overruns the interval must not overlap itself.
- The timer is `unref()`d so it never holds the process open.
- A tick that throws is caught and logged; the loop continues.
- Order selection: `queued`, oldest first, goal not settled, `!dispatch.isClaimed(id)`, `!dispatch.projectBusy(projectId)`, `!dispatch.atCapacity()`.
- Goal transitions: `markRunning` when one of its orders goes in flight, `markDone` when every id it names has settled.

- [ ] **Step 4: Run the tests**

Run: `node --test 'test/scheduler.test.js'`, then the full suite **five times unloaded and three as concurrent pairs**. Concurrent pairs is the shape that found a 14/16 flake in 2b that eighteen single loaded runs missed.

- [ ] **Step 5: Mutation-verify**

Every mutant named in Step 1, plus your own sweep over `lib/scheduler.js`. **Verify your control run is green before trusting any verdict** — a mutant scored against an already-failing test reads as a KILL while proving nothing.

- [ ] **Step 6: Commit**

```bash
git add lib/scheduler.js test/scheduler.test.js
git commit -F- <<'EOF'
feat(scheduler): a goal's orders run themselves

A poll loop, not an event loop, and the reason is specific: a settled order
does not mean its project is claimable, because dispatch releases the project
claim in a finally that runs after worktrees.cleanup. Anything driven by "order
settled" dispatches into a project that is still held.

Every check here is advisory. The authority is the synchronous claim inside
runOrder; these exist to avoid picking work that would certainly be refused. A
caller that bypasses the scheduler is bounded exactly as well.

childEnv is required rather than defaulted, for the third time in this
codebase: the only sensible default is process.env, which is the leak the
allowlist exists to prevent.
EOF
```

---

## Task 5: Wiring and status

**Files:**
- Create: `routes/scheduler.js`
- Modify: `server.js`
- Test: `test/scheduler-api.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-api.test.js`, modelled on `test/goals-api.test.js`. Pin:

```js
test('GET /api/scheduler reports that it is running', ...)
test('a goal posted over HTTP runs to completion with nobody dispatching', ...)
  // The deliverable. Register a git project → POST a goal → shim PM plans two
  // → poll until BOTH orders are `succeeded` and the goal reads `done`.
test('the scheduler is stopped before agents are reaped at SIGTERM', ...)
  // Otherwise it dispatches into a shutting-down server. Verify with ps that
  // no agent survives, the way 825b02d was verified - the AGENT is dead, not
  // merely the server exited.
test('the scheduler holds the drain open', ...)
  // An order the scheduler started must count in agentsRunning().
```

- [ ] **Step 2–3: Run to verify failure, then implement**

`routes/scheduler.js` follows the `(deps) => async ({req,res,u,p}) => handled|false` factory shape and calls `requireDeps` from `routes/deps.js` — **both sibling routes do, and `routes/deps.js` exists precisely because both once carried a comment promising a boot-time fault they did not deliver.**

In `server.js`, **wiring only** — it is 1220 lines against this repo's 800 ceiling and a `/code-review` run flagged that as HIGH:
- `scheduler.start(...)` after the boot reconciles.
- `scheduler.stop()` **before** `dispatch.cancelAll()` in the shutdown block, so nothing is dispatched into a shutting-down server.

- [ ] **Step 4–5: Run, then mutation-verify**

```bash
# M1: scheduler.start never called        → the end-to-end test FAILS
# M2: stop() called AFTER cancelAll       → the shutdown test FAILS
# M3: requireDeps call dropped            → the factory test FAILS
# M4: GET route answers any method        → a POST must not reach it
```

M4 matters: in 2b a dispatch route answered any method, so **a GET could spawn a credentialed agent.** That survived the first sweep.

- [ ] **Step 6: Commit**

```bash
git add server.js routes/scheduler.js test/scheduler-api.test.js
git commit -F- <<'EOF'
feat(api): wire the scheduler, and a status route

start() after the boot reconciles, stop() before cancelAll - in that order,
because a scheduler still ticking during shutdown dispatches into a server
that is reaping.

The scheduler lives in lib/ and its route in routes/ rather than in server.js,
which is 1220 lines against this repo's 800 ceiling.
EOF
```

---

## Self-review

**Spec coverage.** §4's *"scheduler dispatches up to `concurrency` at a time"* — Tasks 4 and 5. §5 isolation under real concurrency — Task 2. The goal lifecycle §3 implies — Task 3. **Not covered, deliberately, and named in the scope table:** §4's verdict round-trip and §3's `supersedes`/`verdict` fields, both 2d; §8's board, Plan 3.

**Carried-forward items.** (1) polling `projectBusy` — Task 4, pinned by its own test. (2) `running` — Task 3. (3) worktree race — Task 2. (4) claimed-id query — Task 1. (6) per-goal spend — Task 4. (7) capacity refusal leaving a queued order — Task 4 handles it by not dispatching over capacity in the first place, and the order simply stays queued for the next tick, which is now correct rather than stranded. **(5) worktree GC — deferred, with reasons, in the scope section.**

**Type consistency.** `dispatch.isClaimed(orderId)` (Task 1) is called that way in Task 4. `goals.markRunning(root, id)`, `goals.markPlanned(root, id)`, `goals.markDone(root, id)` (Task 3) likewise. `scheduler.start(root, {intervalMs, childEnv, agentFor})` / `scheduler.stop()` (Task 4) match Task 5's wiring. `worktrees.prepare(root, project, orderId)` is unchanged — the mutex is internal.

**Known weak points in this plan, stated rather than hidden.** Task 2's second test may pass under a global lock, and Task 3's translate-on-read may collide with `markRunning`. Both are called out inline as the likeliest places this plan is wrong, because eleven of my errors in Plan 2b were exactly this shape and none were found by reading.
