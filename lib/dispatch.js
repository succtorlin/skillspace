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
// - CONCURRENT `git worktree add` ON ONE REPO RACES ABOVE ~4. Six concurrent
//   orders on a single git project produce
//   `fatal: failed to read .git/worktrees/<id>/commondir` - one add enumerating
//   the worktree list while another is mid-creation. Measured 0/6 trials
//   failing at the shipped MAX_CONCURRENT_RUNS default of 4, so it is out of
//   reach unless SKILLSPACE_MAX_RUNS is raised. It fails honestly, the order is
//   marked failed and prepare leaves nothing behind. Distinct from
//   lib/projects' "overlapping working trees" note, which is about two records
//   over one tree rather than two adds at one moment.

const inFlight = new Map(); // orderId -> runner handle, for cancel
// orderId -> projectId, so an UNISOLATED project can be serialised. inFlight is
// keyed by order id, which cannot answer "is another order already running in
// this directory". Claimed and released in lockstep with inFlight, at the same
// two lines, so there is still one acquisition and one release.
const projectOf = new Map();

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

  // Not the same thing as project.concurrency, which is the scheduler's. This
  // is one order dispatched twice: on a git project both racing `worktree add`
  // calls fail, but a dir project has no interlock and both agents would run
  // in the user's own directory - and since inFlight is keyed by order id, the
  // second would overwrite the first's handle and cancel() would reach neither.
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

module.exports = { runOrder, cancel, cancelAll, inFlightCount, projectBusy, logFileFor };
