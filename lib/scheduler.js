'use strict';
const orders = require('./orders');
const goals = require('./goals');
const projects = require('./projects');
const dispatch = require('./dispatch');

// Runs a goal's orders without a human dispatching each one.
//
// TWO KINDS OF CHECK LIVE HERE, and calling them all advisory - as this
// comment did until a mutation sweep showed otherwise - points the reader at
// the wrong one.
//
// The first kind SHADOWS a gate dispatch.runOrder already enforces: isClaimed
// shadows its duplicate check, projectBusy its unisolated-project check,
// atCapacity its ceiling. THOSE are purely advisory. The authority is the
// synchronous claim inside runOrder, and a caller that skips this module
// entirely is bounded exactly as well; these exist only to avoid pointless
// work. Delete one and nothing becomes unsafe - runOrder refuses, the order
// stays `queued`, the next tick tries again - so their ONLY observable is the
// refusal. That is why the tests pin them on stats().refused rather than on
// agent counts, which cannot tell a working check from a missing one.
//
// The second kind has NO counterpart in runOrder and is therefore LOAD-BEARING:
// whether the goal is settled, whether it is still being planned, whether its
// record can be read at all, the per-goal budget, and the daily cap. runOrder
// knows nothing about goals, and it answers a reached daily cap by marking the
// order FAILED rather than refusing it. Delete one of those and the damage is
// real and durable - an agent on a plan that does not exist yet, or an entire
// backlog settled `failed` in a single tick. Those are pinned on what happens,
// not on the refusal count.
//
// A POLL LOOP RATHER THAN AN EVENT, and the reason is specific: a settled order
// does NOT mean its project is claimable, because dispatch releases the project
// claim in a finally that runs after worktrees.cleanup - several git calls on a
// git project. Anything driven by "order settled" therefore dispatches into a
// project still held. Polling projectBusy() is what that costs.
//
// The second reason is the one lib/goals names this module for: A GOAL'S ORDERS
// CAN ALL SETTLE DURING BOOT, before this loop exists. lib/orders.reconcile
// settles a crashed goal's `running` orders to `interrupted`, then
// lib/goals.reconcile demotes the goal to `planned` - so boot can produce a
// goal claiming outstanding work with nothing outstanding, and NO FURTHER
// SETTLEMENT EVENT WILL EVER FIRE FOR IT. A purely reactive scheduler never
// fixes that goal. Reproduction is a single restart.
//
// The sweep that fixes it is not a separate startup pass. Every tick
// reconciles every live goal against its orders' real states, and start() runs
// one tick immediately rather than waiting out the first interval - so the
// startup sweep is the first tick, and a goal that goes all-settled at any
// later moment is corrected by the same code rather than by a second copy of it
// that could drift. reconcileGoals() below is that pass.
//
// It never calls goals.reconcile() or orders.reconcile(). Both are BOOT-ONLY
// and unguarded: mid-run, goals.reconcile() demotes every genuinely `running`
// goal and FAILS every `planning` goal a PM is still decomposing, silently and
// with no count to notice it by. markRunning/markPlanned/markDone are the
// per-goal, patch()-routed movers, and they are what this uses.
//
// Known limits:
// - THE TICK IS O(orders + goals). orders.list() opens every order record and
//   goals.list() opens every goal record, on every tick. lib/orders already
//   names an index as belonging with the board's polling; this is the second
//   caller that wants it. Measured there at 41ms for 2000 orders.
// - NOTHING HERE RETRIES A FAILED ORDER, AND `done` DOES NOT MEAN "SUCCEEDED".
//   The plan this was written from predicted that a goal with a failed order
//   "stays short one order forever". It does not, and the difference matters:
//   `failed`, `cancelled` and `interrupted` are all in orders.SETTLED, so such
//   a goal DOES satisfy "every id it names has settled" and IS marked done -
//   over work that never reached a zero exit. That is the honest meaning of the
//   state, which is "nothing outstanding" and not "it worked", and it is
//   exactly why judging the OUTCOME is the PM verdict rather than this loop's
//   job; verdicts and supersedes arrive in plan 2d. Pinned rather than assumed:
//   the boot-sweep test settles one order succeeded and one failed and expects
//   `done`.
// - AT MOST ONE ORDER PER PROJECT AT A TIME, and project.concurrency is not
//   consulted. Selection asks dispatch.projectBusy(), which is true for EVERY
//   in-flight order of that project, git or not - lib/dispatch's isClaimed
//   comment says exactly that, and calls it refusing orders that are safe to
//   run in their own worktrees. Deliberate, and deliberately in the RESTRICTIVE
//   direction: projects.js gives a git project concurrency 2 by default and
//   nothing here honours it, so shipped throughput is 1 per project even where
//   2 is configured. lib/dispatch's own header says the scheduler "calls this
//   in a loop bounded by project.concurrency"; this one is bounded lower than
//   that, not higher. Widening it needs a per-project in-flight COUNT, which
//   dispatch exports no way to ask for - projectBusy is a boolean.
// - A RECORD IT CANNOT READ STALLS THE WORK RATHER THAN SETTLING IT. An order
//   whose project or goal record is missing or unparseable is skipped on every
//   tick, forever; a goal naming an order that no longer exists never reaches
//   `done`. Both fail closed, which is safe here only because dispatching by id
//   is still a human's door - the stalled work is reachable, just not by this.
// - A GOAL WHOSE PER-GOAL BUDGET REFUSES ITS REMAINING ORDERS STAYS `planned`
//   FOREVER. maxOrdersPerGoal bounds what this will spend, so the orders past
//   the cap are never dispatched, never settle, and the goal never reaches
//   `done`. That is the same shape as the failed-order limit above and is
//   visible in the record rather than hidden.
// - THE RE-ENTRANCY GUARD IS CURRENTLY UNREACHABLE, and this comment is not
//   claiming it protects anything today. Every call in a tick is synchronous -
//   runOrder is deliberately NOT awaited - so setInterval cannot re-enter it.
//   A mutation sweep says so rather than the reasoning alone: deleting the
//   guard leaves the whole suite green, and it is recorded here as an argued
//   equivalent rather than chased with a test that could not be written.
//   It stays because the first call in here that becomes asynchronous (an
//   indexed orders.list, a project probe) would overlap ticks silently, and
//   because that same synchrony is load-bearing for a different reason: it is
//   what keeps each advisory check atomic with respect to runOrder's claim, in
//   the way lib/dispatch and lib/plan both had to learn.
// - NOTHING CALLS start() IN PRODUCTION YET. server.js still boots without a
//   scheduler and every order is dispatched by a human through the route, so
//   this module is unreached rather than dead - the same distinction lib/goals
//   draws for the three movers it added for this module's benefit, and it asks
//   there that they not be swept as unused. Wiring it into boot is a change to
//   server.js, which owns MAX_CONCURRENT_RUNS, the childEnv allowlist and the
//   agent registry - the three things start() requires and this module refuses
//   to invent.
// - stop() DOES NOT CANCEL IN-FLIGHT ORDERS. It stops picking new work; orders
//   already dispatched run to completion and settle normally. Cancelling them
//   is dispatch.cancelAll(), which is the shutdown path's job, not this one's.
// - warnedOnce grows by one entry per order that is permanently unrunnable
//   (no agent, no project). Bounded by the number of such orders, not by time,
//   and it is the same trade lib/orders makes for its malformed-record warning:
//   one line per id beats one line per id per poll.

// The poll cadence. A default is fine here in a way that childEnv's would not
// be - this is a throughput knob, not a policy that can leak anything.
//
// Anything below the floor is treated as UNCONFIGURED and takes the default; it
// is not clamped up to the floor. A caller passing 0 or 1 has not made a
// considered choice about cadence, and the default is the considered one -
// whereas honouring it literally is a loop that re-reads every record in the
// store a thousand times a second and starves the event loop it shares with
// every agent's stdout.
const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 10;

let timer = null;
let config = null;
let ticking = false;
const counts = { ticks: 0, dispatched: 0, refused: 0, errors: 0 };
let lastError = null;
const warnedOnce = new Set();

function warnOnce(key, message) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn('[scheduler] ' + message);
}

// start(root, { intervalMs, childEnv, agentFor })
//
// childEnv is REQUIRED and deliberately not defaulted, for the third time in
// this codebase. The only sensible default is process.env, which on a
// developer's machine is every AWS, GitHub and npm token they hold, handed to
// an agent that needs its own provider key - precisely the leak the allowlist
// exists to prevent. lib/dispatch refuses per order and lib/plan refuses per
// goal; this refuses at start(), because a scheduler is configured once and a
// misconfiguration should fail at boot rather than at the first order.
//
// agentFor(order, project) is required for the same reason in a different
// currency: there is no sensible default agent, and picking one would run a
// human's prompt through a tool they did not choose. It MUST BE SYNCHRONOUS -
// see the re-entrancy note above - and returning nothing is a legal answer
// meaning "not now", not an error.
function start(root, options) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('root is required');
  }
  const opts = options && typeof options === 'object' ? options : {};
  if (typeof opts.childEnv !== 'function') {
    throw new Error('childEnv is required: a scheduler must not hand agents process.env');
  }
  if (typeof opts.agentFor !== 'function') {
    throw new Error('agentFor is required: there is no default agent to run a human\'s prompt through');
  }
  // Refused rather than silently replaced. Two schedulers in one process is a
  // configuration fault, and a replace would hide it while leaking the first
  // timer - the shape that leaves a second loop dispatching against a root
  // nobody remembers configuring.
  if (timer) throw new Error('scheduler is already started');

  const raw = Number(opts.intervalMs);
  const intervalMs = Number.isFinite(raw) && raw >= MIN_INTERVAL_MS
    ? Math.floor(raw)
    : DEFAULT_INTERVAL_MS;

  config = { root, childEnv: opts.childEnv, agentFor: opts.agentFor, intervalMs };
  counts.ticks = 0;
  counts.dispatched = 0;
  counts.refused = 0;
  counts.errors = 0;
  lastError = null;
  ticking = false;

  timer = setInterval(runTick, intervalMs);
  // So the loop never holds the process open. A background poll is not a reason
  // for `node -e "require('./lib/scheduler').start(...)"` to hang forever, and
  // the server has its own reasons to stay alive.
  timer.unref();

  // IMMEDIATELY, not after the first interval: this call is the startup sweep
  // that lib/goals asks for. A goal whose orders all settled during boot has no
  // settlement event left to fire, and waiting out an interval to notice it
  // would only make the stale window longer, not different.
  runTick();
  return { intervalMs };
}

// Clears the timer AND every piece of loop state, so a later start() is a clean
// start. Which parts of that are load-bearing, precisely, because two of the
// three are and one is not:
//
//   timer   MUST be cleared, or the orphaned interval keeps firing and starts
//           finding work again at the next start() - two loops at twice the
//           configured rate, one more per stop/start cycle. Nulling the handle
//           without clearInterval gets exactly that, and is its own test.
//   config  MUST be dropped, so an interval that somehow outlives the clear
//           finds nothing to do rather than dispatching against a stale root.
//   ticking is reset for completeness only, and this is NOT claiming it does
//           anything today: the tick is synchronous, so the flag is already
//           false whenever stop() can be reached. It matters on the day the
//           tick becomes asynchronous - the change the Known limits anticipate
//           - when a stop() landing mid-tick would otherwise leave it set and
//           make every future tick short-circuit: a scheduler that reports
//           itself started and does nothing at all.
//
// Safe to call when not started.
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  config = null;
  ticking = false;
}

function stats() {
  return { ...counts, lastError, running: !!timer };
}

function runTick() {
  // See the Known limits note: unreachable while every call in tick() is
  // synchronous. Kept as a tripwire, not credited with protecting anything now.
  if (ticking) return;
  if (!config) return;
  ticking = true;
  try {
    counts.ticks += 1;
    tick(config);
  } catch (e) {
    // A poll loop that dies silently is indistinguishable from one that has no
    // work, which is the worst failure this module could have: the board fills
    // with queued orders and nothing says why. Counted and logged, and the
    // interval survives - setInterval would keep firing regardless, but the
    // throw would escape to an uncaught handler and take the process with it.
    counts.errors += 1;
    lastError = e && e.message ? e.message : String(e);
    console.error('[scheduler] tick failed:', lastError);
  } finally {
    ticking = false;
  }
}

// One snapshot of the store per tick, shared by both passes. Re-reading between
// them would not be more accurate - the records this tick just claimed are
// still `queued` on disk either way, because runOrder marks them running after
// `worktree add` - and would double an already O(orders) tick.
function tick(cfg) {
  const { root } = cfg;
  const all = orders.list(root);
  const byId = new Map(all.map((o) => [o.id, o]));
  dispatchPass(cfg, all, byId);
  reconcileGoals(root, byId);
}

function dispatchPass(cfg, all, byId) {
  const { root, childEnv, agentFor } = cfg;
  // list() is newest-first by contract, and filter preserves order, so one
  // reverse gives oldest-first. Deliberately not re-sorting: a second copy of
  // orders.js's comparator - createdAt then id, the id being the only record of
  // order within a millisecond - is a copy that can drift from the original.
  const queued = all.filter((o) => o.status === 'queued').reverse();

  const projectCache = new Map();
  const goalCache = new Map();
  const dayCache = new Map();

  for (const order of queued) {
    // The global ceiling. `break`, not `continue`: it spans both spawn pools and
    // nothing later in this loop can lower it, so there is no candidate left
    // this tick that would fit.
    if (dispatch.atCapacity()) break;

    // Ask isClaimed about ORDERS, projectBusy about DIRECTORIES - they answer
    // over different populations and lib/dispatch says so at length. This one
    // reads inFlight, which only runOrder writes, and names the window where
    // the HTTP route has dispatched this order but the record still reads
    // `queued` because `worktree add` has not finished.
    //
    // AND IT IS REDUNDANT TODAY - measured, not suspected: deleting this line
    // leaves the whole suite green. runOrder sets inFlight and projectOf at the
    // same two lines and deletes them at the same two lines, so isClaimed(id)
    // implies projectBusy(that order's project), and the unconditional
    // projectBusy check below already refuses every candidate this one would.
    // It is kept rather than deleted because that implication is dispatch's
    // internal lockstep, not a contract it publishes, and it is the FIRST thing
    // that breaks under the obvious next change: narrowing projectBusy to
    // unisolated projects - which is what runOrder itself does - to recover the
    // per-project concurrency named in the Known limits. This line is what would
    // still stop a double dispatch then, and it is what lib/dispatch's isClaimed
    // comment exists for. Cheap enough that carrying it is not the question.
    if (dispatch.isClaimed(order.id)) continue;

    const project = cached(projectCache, order.projectId, (id) => projects.get(root, id));
    if (!project) {
      warnOnce(`noproject:${order.id}`,
        `order ${order.id} names a project that cannot be read; leaving it queued`);
      continue;
    }

    // Cheap and the most common blocker, so it goes before the daily-cap scan
    // below. This ordering is about COST, not about precedence - unlike the
    // routes and runOrder, no message here depends on which check answers
    // first, because a skipped candidate is simply retried next tick.
    //
    // This is the check that cannot be replaced by the record's status: an
    // order reads `succeeded` from disk while runOrder's finally is still
    // inside worktrees.cleanup, and projectOf.delete has not run. It is also
    // the only check that sees lib/plan's PM claim, which is held under a GOAL
    // id and is therefore invisible to isClaimed.
    if (dispatch.projectBusy(project.id)) continue;

    if (order.goalId) {
      const goal = cached(goalCache, order.goalId, (id) => goals.get(root, id));
      // Fail closed on a goal we cannot read: we cannot tell whether it is
      // settled, or still being decomposed by a PM that would roll this order
      // back. A human can still dispatch it by id.
      if (!goal) {
        warnOnce(`nogoal:${order.id}`,
          `order ${order.id} names a goal that cannot be read; leaving it queued`);
        continue;
      }
      if (goals.SETTLED.has(goal.status)) continue;
      // `planning` IS NOT SETTLED, AND IS NOT SAFE. lib/plan attaches each
      // order to the goal as it creates it and only calls goals.planned at the
      // end, so there is a real window in which this order is `queued`, carries
      // a goalId, and belongs to a plan that is not finished. If persisting the
      // plan then fails, plan.js's rollback calls orders.markCancelled on every
      // id it recorded - which would settle an order this scheduler had already
      // put an agent on, behind dispatch's back, and dispatch's own
      // markFinished would then be refused by the settled guard. That is the
      // "NOTHING MAY SETTLE A RECORD ANOTHER DISPATCH ALREADY OWNS" invariant
      // runOrder is built around, broken from the outside. plan.js names this
      // exact hazard - "invisible work a scheduler may still run".
      if (goal.status === 'planning') continue;

      // PER-GOAL SPEND. goal.orderIds is the authoritative list - plan.js says
      // so, and an order's goalId is only a back-pointer that survives a
      // rollback - but it is STORED UNVALIDATED, so it gets the same
      // Array.isArray guard routes/goals.js already carries. A goal whose
      // orderIds is not an array is one whose spend cannot be bounded, so it is
      // skipped rather than run unbounded.
      if (!Array.isArray(goal.orderIds)) {
        warnOnce(`badids:${goal.id}`,
          `goal ${goal.id} has a malformed orderIds; leaving its orders queued`);
        continue;
      }
      // Anything not `queued` has already been spent on: running, or settled.
      // +1 for the candidate, because withinBudget asks whether a plan of that
      // size fits, and this order would be the nth.
      const spent = goal.orderIds.reduce((n, id) => {
        const rec = byId.get(id);
        return rec && rec.status !== 'queued' ? n + 1 : n;
      }, 0);
      // goals.withinBudget rather than a comparison written here: it is the
      // function that already fails closed on every shape of a missing cap -
      // 0 and negatives refuse, a mis-typed '12' refuses, and only a wholly
      // absent budget or absent cap means unlimited. A second implementation is
      // a second chance to read one of those as "no limit".
      if (!goals.withinBudget(spent + 1, project.budget)) continue;
    }

    // THE DAILY CAP, MIRRORED RATHER THAN TRUSTED TO RUNORDER. runOrder does
    // enforce it - but it enforces it by marking the order FAILED, which is
    // settled and never retried. A human dispatching by hand burns one order
    // that way; a loop dispatching everything queued burns the whole backlog in
    // one tick, permanently, the moment the cap is reached. Skipping instead
    // leaves them queued for tomorrow, which is the recoverable answer.
    //
    // The comparison is runOrder's verbatim, `>` and all: its order is already
    // persisted when it counts, and `>` cancels that self-inclusion. A
    // different comparison here would refuse an order runOrder would have run,
    // or vice versa.
    const cap = project.budget && project.budget.maxOrdersPerDay;
    if (cap && countToday(dayCache, root, project.id, all.length, cap) > cap) continue;

    // Synchronous by contract. An await between here and runOrder's claim below
    // would let another tick - or an HTTP route - slip between the checks above
    // and the claim that acts on them, which is the window lib/dispatch and
    // lib/plan each had to close in turn.
    const agent = agentFor(order, project);
    if (!agent || typeof agent !== 'object') {
      // NOT dispatched with a missing agent. runOrder would answer that with
      // markFailed('no agent available') - settling it - so a loop that passed
      // the absence through would fail every queued order in the store the
      // first time an agent binary went missing. "Not now" is the honest
      // reading of an absent agent, and `queued` is the honest record of it.
      warnOnce(`noagent:${order.id}`,
        `no agent available for order ${order.id}; leaving it queued`);
      continue;
    }

    counts.dispatched += 1;
    // NOT awaited, exactly as the routes do it: runOrder resolves only when the
    // agent exits, up to the project's orderTimeoutMs. Awaiting would make the
    // tick as long as the longest order and serialise everything.
    dispatch
      .runOrder(root, { order, project, agent, childEnv })
      .then((r) => {
        // runOrder REFUSES by resolving with { refused }; it does not throw.
        // Every refusal reaching here is one of the advisory checks above
        // having been wrong - stale by a tick, or absent - so this counter is
        // the measure of how much pointless work the checks are failing to
        // avoid, and it is what the tests assert those checks on.
        if (r && r.refused) {
          counts.refused += 1;
          console.warn('[scheduler] order %s was not dispatched: %s', order.id, r.refused);
        }
      })
      .catch((e) => {
        // A rejection is a bug in dispatch or a store that cannot be written,
        // not a failed order, and it is the one outcome with no durable trace
        // unless this writes one. Same handling as routes/orders.js, including
        // the try around markFailed: if the store is what failed, recording the
        // failure fails too.
        counts.errors += 1;
        lastError = e && e.message ? e.message : String(e);
        console.error('[scheduler] order %s failed to dispatch:', order.id, lastError);
        try { orders.markFailed(root, order.id, `scheduler: ${lastError}`); } catch (_) {}
      });
  }
}

// Every live goal, every tick, against its orders' real states - not only the
// ones that changed. That is what makes the first tick a startup sweep without
// a second code path: a goal whose orders all settled during boot emits no
// event, so only an unconditional pass can find it.
function reconcileGoals(root, byId) {
  for (const goal of goals.list(root)) {
    if (goals.SETTLED.has(goal.status)) continue;
    // The PM owns a `planning` goal. goals.moveLive would refuse it anyway -
    // HAS_ORDERS excludes `planning` - but reaching for the mover just to have
    // it no-op is a read per goal per tick for nothing.
    if (goal.status === 'planning') continue;
    // Constraint from lib/goals, and the reason planned() refuses an empty
    // plan: "every order it names has settled" is VACUOUSLY TRUE of a goal that
    // names none, and `done` is settled, so a single vacuous pass would be that
    // goal's last word. orderIds is stored unvalidated, so the array-ness is
    // checked here too and not assumed from planned()'s guard.
    if (!Array.isArray(goal.orderIds) || goal.orderIds.length === 0) continue;

    let allSettled = true;
    let anyInFlight = false;
    for (const id of goal.orderIds) {
      // isClaimed, not the record: an order claimed a moment ago still reads
      // `queued` on disk until runOrder marks it running, which is after
      // `worktree add`. A goal would otherwise read `planned` for the tens of
      // milliseconds its first agent is being prepared.
      if (dispatch.isClaimed(id)) {
        anyInFlight = true;
        allSettled = false;
        continue;
      }
      const rec = byId.get(id);
      // A missing order is NOT counted as settled. Treating it as settled would
      // let a goal reach `done` over work that was deleted or quarantined -
      // `done` is settled and never rewritten, so that claim would be the
      // record's last word. Stalling at `planned` is the honest alternative and
      // is visible; see Known limits.
      if (!rec || !orders.SETTLED.has(rec.status)) allSettled = false;
    }

    const desired = allSettled ? 'done' : (anyInFlight ? 'running' : 'planned');
    // WRITE ONLY ON A REAL TRANSITION. lib/goals' moveLive rewrites the record
    // on a no-op - mkdir, write, rename - so a per-tick call would rewrite
    // every goal's file every tick with byte-identical data. goals.js says a
    // polling caller should track what it last wrote; the record just read is a
    // better answer than tracking, because it is also correct after another
    // writer moved the goal. The short-circuit is HERE and not in goals.js for
    // the reason stated there: markDone stamps finishedAt, so "status is
    // unchanged" and "this write changes nothing" are not the same question in
    // general - they are only the same question at this call site, where the
    // three movers below each change status or nothing.
    if (desired === goal.status) continue;
    if (desired === 'done') goals.markDone(root, goal.id);
    else if (desired === 'running') goals.markRunning(root, goal.id);
    // The demotion, and it is not cosmetic: a goal left at `running` while
    // every agent has exited is the same lie - "work in flight with nothing
    // alive" - that this state machine was rebuilt to remove. It happens
    // whenever an order settles and the next is blocked by capacity, a busy
    // project, or the daily cap.
    else goals.markPlanned(root, goal.id);
  }
}

function cached(map, key, read) {
  if (map.has(key)) return map.get(key);
  const value = read(key);
  map.set(key, value);
  return value;
}

// countToday() goes through orders.list(), which opens every order file again -
// so it is memoised per project per tick, and skipped outright when the whole
// store holds no more orders than the cap. That skip is EXACT, not a heuristic:
// countToday(project) can never exceed the total number of orders, so
// total <= cap implies count <= cap implies runOrder's `> cap` is false.
//
// Counted through orders.countToday rather than from the snapshot already in
// hand, because the day boundary is orders.js's localDay - deliberately local
// rather than UTC, so a cap does not reset at 7pm on a UTC-5 host - and it is
// not exported. A second implementation of "today" is a second thing to get
// wrong by a timezone.
function countToday(dayCache, root, projectId, totalOrders, cap) {
  if (totalOrders <= cap) return 0;
  return cached(dayCache, projectId, (id) => orders.countToday(root, id));
}

module.exports = { start, stop, stats };
