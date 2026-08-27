'use strict';
const path = require('path');
const orders = require('./orders');
const worktrees = require('./worktrees');
const runner = require('./runner');

// Puts one order through its whole life: check the budget, prepare an isolated
// cwd, run the agent, record the outcome, clean up. The scheduler in the next
// plan calls this in a loop bounded by project.concurrency; nothing here knows
// about queues or goals.
//
// Ordering is the point of this module. The budget is checked before a
// worktree exists, so a refused order leaves nothing behind at all; a worktree
// that cannot be created fails the order before any agent spawns; and cleanup
// is in a finally, because a failed run must not leave a worktree holding a
// branch.
//
// Every path returns a SETTLED order record except one: a duplicate dispatch is
// refused with the record as it stands plus `refused`. A refusal is not a
// failure of the order - the first dispatch may be running fine - so settling
// it would be a lie, but returning the bare record is worse, because `queued`
// with no error is indistinguishable from an order simply waiting its turn.
// `refused` carries one of three reasons: 'already dispatched' (this same order
// is mid-dispatch), 'project busy' (another order is running in an unisolated
// project's directory), and it is absent on every non-refusal - so
// `if (result.refused)` is the whole discriminator, and the reason is for the
// caller's message, not its control flow. But null-check first. runOrder returns NULL when the record
// is not on disk: deleted, or quarantined by the store as unparseable. orders'
// get()/patch() answer null for that, and this returns it rather than
// fabricating a record-shaped object, which would invent an id and a status for
// something that does not exist. It is a real state the scheduler can hit by
// dispatching a snapshot of an order the user has since deleted.
//
// And it can REJECT. If the store cannot be written, nothing can be recorded -
// including a failure - so markRunning throwing propagates rather than being
// dressed up as a settled order. The claim and the worktree are still released
// on the way out; only the record is left as it was, which for that path is
// `queued`. Recovery is a NEW order, not a re-dispatch of this id: cleanup ran,
// and it keeps the skillspace/<orderId> branch by design, so `worktree add -b`
// for that same id fails ever after with "a branch named ... already exists".
// Measured, not assumed - the retry comes back failed. That matches orders.js's
// convention that a retry supersedes rather than reuses.
//
// `refused` stays a return-value annotation and never reaches disk -
// not because callers are careful, but because patch() is not exported and
// every exported writer takes named fields (markRunning({cwd, agent}),
// markFinished({exitCode, error}), markFailed(string), markCancelled()). Handing
// this object straight to any of them drops `refused` on the floor. Only a
// direct store.writeJson could persist it, and nothing does.

// Known limits, recorded rather than fixed - both are aimed at whoever writes
// the scheduler in plan 2b:
//
// - A SETTLED ORDER DOES NOT MEAN THE PROJECT IS CLAIMABLE. projectOf.delete
//   runs in runOrder's finally, AFTER worktrees.cleanup - which for a git
//   project is several git calls. So an order can read `succeeded` from disk
//   while its project is still busy here. Anything retrying automatically must
//   poll projectBusy() rather than key off the record's status. Harmless today
//   (one microtask for a dir project, and nothing retries yet), real the
//   moment something does.
// - CONCURRENT `git worktree add` ON ONE REPO RACES AT ANY CONCURRENCY >= 2.
//   Two adds on one repo produce
//   `fatal: failed to read .git/worktrees/<id>/commondir` - one add enumerating
//   the worktree list while another is mid-creation.
//
//   THE PREVIOUS MEASUREMENT HERE WAS WRONG, AND WRONG IN THE REASSURING
//   DIRECTION. It read "Measured 0/6 trials failing at the shipped
//   MAX_CONCURRENT_RUNS default of 4, so it is out of reach unless
//   SKILLSPACE_MAX_RUNS is raised", which described a threshold. It is not a
//   threshold, it is a probability, and six trials could not have told the
//   difference. Re-measured, 12 trials per cell: idle, 0/24 adds at K=2, 0/36
//   at K=3, 0/48 at K=4; under eight CPU hogs, 1/48 at K=4 - THE SHIPPED
//   DEFAULT - with the commondir error verbatim. Independently: 1/12 trials at
//   K=3 idle, 1/12 at K=6 under load, and the test suite itself has hit it at
//   K=2 (test/dispatch.test.js). So: rare, load-sensitive, and reachable at
//   defaults. A legitimate order can fail spuriously and should be retried.
//
//   It fails honestly - the order is marked failed and prepare leaves nothing
//   behind - which is why this was recorded rather than urgent.
//
//   FIXED, in lib/worktrees: `worktree add` is now serialised per repository,
//   keyed by project.path rather than globally so unrelated projects still
//   overlap. Measured there at 0/100 runs of an 8-way concurrent prepare with
//   the lock, against 6/100 without. It lives there rather than here because
//   this module cannot impose it on the other callers.
//
//   STILL REACHABLE FROM OUTSIDE THIS PROCESS. The lock is per-process, so a
//   second SkillSpace against one repo - or a human running `git worktree add`
//   by hand - races exactly as before, and still fails closed. Anything
//   retrying automatically should keep treating this as a real failure mode.
//
//   Distinct from lib/projects' "overlapping working trees" note, which is
//   about two records over one tree rather than two adds at one moment.

const inFlight = new Map(); // orderId -> runner handle, for cancel
// orderId -> projectId, so an UNISOLATED project can be serialised. inFlight is
// keyed by order id, which cannot answer "is another order already running in
// this directory". Claimed and released in lockstep with inFlight, at the same
// two lines, so there is still one acquisition and one release.
const projectOf = new Map();

// The process-wide agent ceiling, as a predicate, set once at boot.
//
// PER-PROCESS policy, so it is configured once rather than passed per call -
// that is the line between this and childEnv, which is required on every
// runOrder because it is PER-AGENT policy and genuinely varies. dispatch cannot
// compute this itself: the other half of the count is /api/run's pool, which
// lives in server.js and this module must not reach into.
//
// The gate used to live only in the two routes, which made it opt-in: a caller
// that reached runOrder directly - "run every order in this goal" is the
// obvious plan-2c shape - spawned as many agents as it liked and nothing
// refused it. Enforcing here makes it structural, because runOrder is the one
// door every dispatched agent goes through.
//
// Unconfigured means unbounded. That is the one way left to be wrong, and it is
// deliberate: dispatch has no policy of its own to fall back on, and a unit
// test exercising dispatch's other properties must not inherit a ceiling it
// never asked for. The real process configures it at boot, and BOTH routes ask
// through atCapacity() - so a boot that forgot to call setCapacity loses its
// route gates too, which the ceiling tests in test/orders-api.test.js catch.
let capacityPredicate = null;

function setCapacity(fn) {
  capacityPredicate = typeof fn === 'function' ? fn : null;
}

function atCapacity() {
  return capacityPredicate ? !!capacityPredicate() : false;
}

// Every refusal returns the record as it stands plus `refused`, or null when
// there is no record. Factored so the null guard cannot be right in one refusal
// and wrong in another - the malformed { refused } with no id came from doing
// this inline.
function refuse(root, orderId, reason) {
  const record = orders.get(root, orderId);
  return record ? { ...record, refused: reason } : null;
}

function logFileFor(root, orderId) {
  return path.join(root, 'logs', `${orderId}.log`);
}

async function runOrder(root, { order, project, agent, childEnv, onChunk }) {
  // FIRST, above every gate that can settle the record. Not the same thing as
  // project.concurrency, which is the scheduler's. This is one order dispatched
  // twice: on a git project both racing `worktree add` calls fail, but a dir
  // project has no interlock and both agents would run in the user's own
  // directory - and since inFlight is keyed by order id, the second would
  // overwrite the first's handle and cancel() would reach neither.
  //
  // WHY IT IS FIRST, and this was found the hard way: every check below settles
  // the record with markFailed, and orders.patch() refuses to move a SETTLED
  // record. So a duplicate arriving while the real run was live marked THAT run
  // failed, and the agent's true outcome was silently discarded when it landed
  // - the cost falling on the first dispatch rather than on the second caller.
  // The daily-budget gate reached this on ordinary per-project config: cap 1,
  // one order running, a second order created, re-dispatch the first, and a
  // live order ends `failed - daily limit reached` with a null exit code.
  //
  // A duplicate is a duplicate whatever the budget, the agent, or the child-env
  // policy says. The invariant is the simple one: NOTHING MAY SETTLE A RECORD
  // ANOTHER DISPATCH ALREADY OWNS. The caller faults below still fail loudly on
  // the FIRST order, which is the only place they were ever meant to fire.
  if (inFlight.has(order.id)) {
    // Not a failure of the order: the first dispatch may be running happily,
    // so the record must not be settled. But the caller has to tell "I
    // dispatched it" from "someone else already had", and the bare record says
    // `queued` with no error - which reads as success.
    //
    // A missing record returns null rather than a lone { refused }: spreading
    // an absent record produced an object with no id and no status, which is
    // not an order and would fail any reader that trusted the shape.
    return refuse(root, order.id, 'already dispatched');
  }

  // Cheapest refusals first, so nothing is created for an order we will not run.
  if (!agent) {
    return orders.markFailed(root, order.id, 'no agent available');
  }
  // REQUIRED, deliberately not defaulted. The obvious default is process.env,
  // and that is precisely the bug this closes: on a developer's machine that is
  // every AWS, GitHub and npm token they hold, handed to an agent that only
  // needs its own provider key. A default would let the next caller omit it and
  // leak silently; refusing means the omission fails loudly, at the first order,
  // instead of quietly widening what an agent can read. dispatch cannot supply
  // one itself - the allowlist is the server's policy, not this module's.
  if (typeof childEnv !== 'function') {
    return orders.markFailed(root, order.id, 'no child environment policy supplied');
  }
  const budget = (project && project.budget) || {};
  const cap = budget.maxOrdersPerDay;
  // `>`, not `>=`: this order is already persisted by the time it is dispatched,
  // so countToday includes it, and `>` cancels that self-inclusion to give
  // "a cap of N runs N orders". A future caller that creates the record AFTER
  // this check would silently make the comparison off by one.
  if (cap && orders.countToday(root, project.id) > cap) {
    return orders.markFailed(root, order.id, `daily limit reached (${cap} orders)`);
  }

  // A dir project has no isolation mechanism, so two agents would edit the
  // user's actual directory at once - the corruption lib/worktrees exists to
  // prevent, on the one project kind with no other protection. How CLOSE
  // together the two spawns land is harness-dependent - the same race measures
  // microseconds through HTTP and milliseconds at library level - so no figure
  // is quoted here. The identical cwd is the property, not the interval. A git
  // project needs nothing here: each order gets its own worktree, and how MANY
  // may run at once is a throughput policy for the scheduler, not a
  // correctness guard.
  //
  // After the duplicate check, so re-dispatching one order still says
  // 'already dispatched' rather than blaming the project.
  if (project.kind !== 'git') {
    for (const projectId of projectOf.values()) {
      if (projectId === project.id) return refuse(root, order.id, 'project busy');
    }
  }

  // The ceiling, enforced where the spawn actually happens rather than only at
  // the two routes that politely asked. Checked HERE, immediately before the
  // claim below and with no await between the two, so the check and the claim
  // are atomic with respect to another dispatch on this same event loop -
  // which is the only kind there is.
  //
  // After the duplicate and project-busy checks, matching the routes' order, so
  // a re-dispatch still says 'already dispatched' rather than blaming capacity.
  // Refused, not failed: the order was never started, so `queued` remains the
  // honest status and a future scheduler can pick it up. Nothing retries it
  // today - the routes refuse before creating a record for exactly that reason
  // - so a caller that skips the route check owns the leftover.
  if (atCapacity()) {
    return refuse(root, order.id, 'at capacity');
  }

  // ONE claim, ONE release. Three hand-placed release sites did not tell us
  // when we had missed one, and markRunning was the one nobody counted: it sat
  // in the single gap between the claim and the old finally, so a store write
  // failing there leaked the slot permanently - that order id undispatchable
  // for the life of the process, and inFlightCount() never returning to zero,
  // which is what server.js gates graceful shutdown on.
  inFlight.set(order.id, null); // claim before any await
  projectOf.set(order.id, project.id);
  try {
    let wt;
    try {
      wt = await worktrees.prepare(root, project, order.id);
    } catch (e) {
      // Fails before any agent spawns, with nothing half-created. Deliberately
      // outside the cleanup try below: there is no worktree to clean up, and
      // entering it would call cleanup with an undefined wt.
      return orders.markFailed(root, order.id, e.message);
    }

    try {
      // The record may have settled while we were preparing - a cancel during
      // `git worktree add`, which takes tens of milliseconds on a small repo
      // (~35ms measured on the test fixture) and seconds on a real one.
      // dispatch.cancel() could not reach us (no handle yet) so the route
      // settled the record directly, and patch()'s settled guard would silently
      // no-op markRunning below while we spawned anyway. Check intent before
      // starting an agent nothing can then stop.
      const current = orders.get(root, order.id);
      if (!current || current.status !== 'queued') return current;

      orders.markRunning(root, order.id, { cwd: wt.cwd, agent: agent.id });

      try {
        const handle = runner.start({
          agent,
          prompt: order.prompt,
          cwd: wt.cwd,
          logFile: logFileFor(root, order.id),
          timeoutMs: budget.orderTimeoutMs || 900000,
          // The credential allowlist and CHILD_PATH both live in childEnv.
          // Without it the agent inherits process.env verbatim - every AWS,
          // GitHub and npm token on the machine - and is spawned with a PATH
          // that does not include ~/.local/bin, so an agent that /api/config
          // reports as installed fails with ENOENT.
          env: childEnv(agent),
          onChunk,
        });
        inFlight.set(order.id, handle);
        const result = await handle.done;

        if (result.error === 'cancelled') return orders.markCancelled(root, order.id);

        // NO PROCESS EVER EXISTED, so `startedAt` must not say one did. lib/orders
        // states the rule and names this exact case: markFailed is "a failure
        // before anything started - a worktree that could not be created, AN
        // AGENT BINARY THAT IS NOT INSTALLED", and it nulls startedAt so that
        // "the board reads a non-null startedAt as 'this actually ran'".
        // markRunning is written one line above the spawn, so an ENOENT - a
        // renamed binary, a PATH change, an uninstall mid-run - used to settle
        // `failed` with a startedAt, which reads as an agent that ran and died.
        //
        // That is not cosmetic. A scheduler classifying outcomes off this field
        // counted every such order as a successful start, so a broken binary
        // drained a whole backlog while the brake meant to stop it was being
        // reset by the very failures that should have armed it. Twelve orders in
        // two seconds, measured, with the goal then reading `done`.
        //
        // AFTER the cancelled check, which must stay first: a cancel landing
        // before a nextTick ENOENT is a cancellation, not a missing binary, and
        // lib/runner's tests pin that race.
        if (result.spawned === false) {
          return orders.markFailed(root, order.id, result.error || 'the agent never started');
        }

        return orders.markFinished(root, order.id, {
          exitCode: result.exitCode,
          error: result.error,
        });
      } catch (e) {
        // runner.start can throw synchronously - an unwritable log directory is
        // enough. Without this the record stays `running` until reconcile()
        // flips it at the next boot, so the board shows a live order with no
        // process behind it. markFinished with an error yields failed/exitCode
        // null, which is the right shape: this is a failure we caused, not an
        // agent exit.
        //
        // Scoped to the run itself. A markRunning that throws is NOT caught
        // here: the throw is the store refusing to record anything, so there is
        // no way to record a failure either, and pretending otherwise would
        // write a status we could not write.
        return orders.markFinished(root, order.id, { error: `dispatch: ${e.message}` });
      }
    } finally {
      // Everything that got a worktree cleans it up - including a store write
      // that throws between prepare and the run. A failed or cancelled run must
      // not leave a worktree holding a branch. No-op for a dir project.
      await worktrees.cleanup(wt);
    }
  } finally {
    inFlight.delete(order.id);
    projectOf.delete(order.id);
  }
}

// Whether an order is already in flight for this project. The route asks
// before creating a record, so a second concurrent order on an unisolated
// project is refused with a 409 instead of becoming a queued order nothing will
// ever dispatch - there is no scheduler yet to pick it up later. This is a
// convenience for that message only: the guard inside runOrder is the actual
// protection, and it re-checks under the same claim it then takes.
function projectBusy(projectId) {
  for (const id of projectOf.values()) if (id === projectId) return true;
  return false;
}

// Is this specific order in flight right now? The scheduler needs this and
// projectBusy cannot stand in: projectBusy is true for EVERY git order on the
// project, so a scheduler using it would refuse orders that are perfectly safe
// to run in their own worktrees.
//
// A DIFFERENT POPULATION from projectBusy, despite arriving beside it. This
// reads inFlight, which only runOrder writes. projectBusy reads projectOf,
// which lib/plan also writes under GOAL ids - so isClaimed('goal-...') is false
// while that goal's PM agent is live in the user's own directory. Ask this one
// about orders and projectBusy about directories; the scheduler drives both.
//
// Advisory: the authority is the duplicate check inside runOrder, which is that
// function's FIRST gate precisely so a caller who skips this is refused rather
// than having its live order settled by a gate meant for someone else. This
// NARROWS a window rather than closing one, and only for a caller that reaches
// runOrder with no await in between - which is what the HTTP route does. It is
// not a lock, and nothing here serialises anything.
//
// No type guard on orderId: Map.has already returns false for any key it never
// saw, of any type, without throwing. One was written here and removed once it
// turned out to change no answer and to not make the return type a boolean
// either, which is what it had been credited with doing.
function isClaimed(orderId) {
  return inFlight.has(orderId);
}

// The claim, opened up so the OTHER spawn path can join the same pool. lib/plan
// runs a PM agent, and on a dir project that PM is in the user's own directory
// with no isolation - the case worktrees.prepare names in the imperative and
// records as having actually happened. A second registry would not have helped:
// the property is that a PM and a dispatched order cannot both be in one
// unisolated directory, and that can only be answered by ONE set. So plan.js
// claims here, under its goal id, and projectBusy() sees both kinds.
//
// Keys are goal ids from lib/plan and order ids from runOrder. They cannot
// collide - the prefixes are 'goal-' and 'ord-' - and nothing here reads the
// key as anything but an opaque handle to release with.
function claimProject(key, projectId) {
  projectOf.set(key, projectId);
}

function releaseProject(key) {
  projectOf.delete(key);
}

function cancel(orderId) {
  const handle = inFlight.get(orderId);
  if (!handle) return false;
  handle.cancel();
  return true;
}

// Shutdown only. Agents are spawned detached - their own process group - so a
// signal sent to the server's group never reaches them, and the timeout that
// bounds a stuck agent is a setTimeout inside the SERVER process, which dies
// with it. Killing the console without this leaves credentialed agents running
// with no time bound at all, reparented to init.
//
// Iterating a copy of the keys: cancel() is synchronous and the runner's
// finish() deletes from inFlight, so walking the live map would be editing the
// collection under the iterator.
//
// Counts only orders with a handle. An order still preparing its worktree has
// none yet, so it is not counted and not signalled - it is stopped instead by
// the intent check runOrder performs after prepare, which sees the settled
// record and returns without spawning. That check is what makes this safe; an
// earlier version of this comment claimed such an order spawned nothing, and
// it did.
//
// Residual, on the shutdown path only: cancelAll does not itself settle those
// records, so an order mid-prepare is stopped only if something has already
// marked it. On a plain SIGTERM nothing has, so it stays `queued`, prepare
// finishes, the intent check sees `queued` and the agent starts - after
// shutdown began, to be abandoned by the 6s hatch. When the hatch fires, the
// process dies inside runOrder's await, so the finally never runs and
// worktrees.cleanup is never called: that order's worktree DIRECTORY is left
// on disk and git still has it registered, to be reconciled by hand or by the
// next `worktree prune`. The branch is not part of that loss - cleanup keeps
// it by design on every path - but the uncommitted contents of the tree are.
// Bounding this needs a shutting-down flag runOrder can read, which is plan
// 2b's consolidation of the two in-flight registries.
function cancelAll() {
  let n = 0;
  for (const orderId of [...inFlight.keys()]) {
    if (cancel(orderId)) n++;
  }
  return n;
}

// How many orders are still mid-dispatch. Note that runOrder deletes from
// inFlight in a `finally`, which runs AFTER the return expression that records
// the outcome - so a count of zero means every order has already been written
// to disk, not merely that the agents have exited. The shutdown path relies on
// exactly that.
function inFlightCount() {
  return inFlight.size;
}

module.exports = {
  runOrder, cancel, cancelAll, inFlightCount, projectBusy, isClaimed, logFileFor,
  setCapacity, atCapacity, claimProject, releaseProject,
};
