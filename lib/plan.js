'use strict';
const path = require('path');
const goals = require('./goals');
const orders = require('./orders');
const worktrees = require('./worktrees');
const runner = require('./runner');
const pm = require('./pm');
const dispatch = require('./dispatch');

// goalId -> runner handle, for shutdown. The PM is the FOURTH spawn path in
// this codebase, and each of the previous three had to learn the same thing
// separately: agents are spawned DETACHED, so a signal sent to the server's
// process group never reaches them, and the timeout that bounds a stuck agent
// is a setTimeout inside the server process which dies with it. A PM missing
// from this map at SIGTERM is a credentialed agent reparented to init with no
// time bound at all. server.js reaps this alongside dispatch's pool.
const inFlight = new Map();

// Shutdown only, and the same shape as dispatch.cancelAll for the same reason.
function cancelAll() {
  let n = 0;
  for (const handle of [...inFlight.values()]) {
    if (handle) { handle.cancel(); n++; }
  }
  return n;
}

// Counted into the server's agent total, so a running PM holds the drain open
// and occupies a slot in the process-wide ceiling - it is an agent like any
// other.
//
// TWO PHASES, exactly as dispatch's claim has: decompose() sets the entry to
// null in the same synchronous run as its other admission decisions, and
// planWithClaim overwrites it with the handle once the agent is actually
// spawned. cancelAll()'s null check is what that shape is for.
//
// This sentence used to be here and was FALSE: "zero means the goal is already
// written, not merely that the child exited". The delete lived in
// planWithClaim's inner finally, which runs before the extraction, the
// orders.create loop and goals.planned - so the count reached zero with the
// goal still `planning`, and the shutdown drain could exit over it. The delete
// is now decompose's, whose finally really does run after the record is
// written, and the inner finally only drops the handle.
function inFlightCount() {
  return inFlight.size;
}

// Runs the PM and turns what it says into persisted orders. This is the seam
// plan 2c's scheduler will call after a goal is created.
//
// The PM is spawned through the same runner as any other agent - one spawn
// path, one timeout, one process-group reap. It gets an isolated worktree for
// the same reason orders do: the prompt tells it not to modify anything, which
// is a hope rather than a guarantee, and a worktree makes it true.
//
// This module owns ANSI stripping. lib/pm.js states that as a precondition and
// deliberately does not strip as well, so exactly one layer is responsible and
// a maintainer removing it here does not find the behaviour mysteriously
// preserved somewhere else.
//
// Known limits:
// - Orders are persisted `queued` and nothing dispatches them. That is plan
//   2c's scheduler; until then a human dispatches them individually through
//   POST /api/orders, which is the approval gate the spec's 9 says v1 lacks.
// - THE DAILY-CAP CHECK OPENS EVERY ORDER RECORD for the project, and it runs
//   in decompose's synchronous prologue - which POST /api/goals reaches inside
//   the request tick, since it starts the planner without awaiting it. So the
//   route's response time now carries a fan-out over the store. Measured under
//   load at 6-21ms for the whole POST against its 2000ms budget, at test-suite
//   store sizes; it grows with the day's orders, and the index lib/orders
//   already wants for list() is the fix for both.
// - THE PM RUN ITSELF IS NOT COUNTED against maxOrdersPerDay. The gate below
//   refuses to PLAN when the day's order budget is already spent, which bounds
//   the common case, but a PM that fails to produce a plan creates no order and
//   so leaves the count where it found it - meaning a goal whose PM always
//   fails can be re-posted indefinitely, each time spending a real agent run.
//   Counting PM runs needs a counter that does not exist yet: maxOrdersPerDay
//   is derived from the order records themselves, and a PM leaves none. It
//   belongs with 2c's scheduler, which is where per-goal spend is decided.
// - A dir project cannot be isolated, so the PM reads and could write the
//   user's own directory. Same limitation as an order on a dir project.
// - With NO cap configured, the `maxOrders` the prompt asks for is a request
//   and not a limit: goals.withinBudget deliberately reads an absent cap as
//   unlimited, so a PM that ignores the number is obeyed. Every project
//   lib/projects creates carries a cap, so this is reachable only for a
//   hand-built project record.
// - CAPTURE_CAP counts JS characters, not bytes, and is compared against a
//   decoded string - so a transcript of multi-byte text trips it later than the
//   number suggests. It is a runaway guard, not an accounting boundary.
// - A cleanup failure does not fail the goal: the plan is already on stdout by
//   then, and losing it to a leaked directory would be the worse trade. It is
//   WARNED, by reading cleanup()'s return value - cleanup signals failure by
//   returning { removed: false, preserveError }, it does not throw, so a caller
//   that ignores the return learns nothing. An earlier version of this comment
//   also claimed the leak was self-limiting because prepare() refuses a
//   non-empty worktree: false. That guard only fires for the SAME id, and goal
//   ids never repeat, so a leaked worktree is silent, permanent and unbounded
//   unless someone reads the warning. The warning is the whole mechanism.
// - The PM's branch is deleted when the worktree came back clean, because the
//   PM's output is the plan on stdout and a branch per goal is pollution in the
//   user's repository. It is KEPT when cleanup committed something - a PM that
//   wrote files disobeyed "do NOT modify any files", and that evidence is worth
//   more than the tidiness. An order's branch is always kept, deliberately;
//   this is the one caller that asks for anything else.
// - RETURN CONTRACT, the same one lib/dispatch documents: decompose resolves to
//   the goal record, or to NULL when that record no longer exists - store.js
//   quarantines an unparseable file, and any future delete route does it on
//   purpose. Every write here goes through goals.patch, which returns null for
//   a goal it cannot read, so null can come back from any path. A caller doing
//   `result.status` without checking gets a TypeError.
// - The goal's orderIds is AUTHORITATIVE; an order's goalId is a back-pointer.
//   After a rollback the goal keeps orderIds: [] while the cancelled orders
//   still carry its goalId, and the two disagree on purpose - the plan was not
//   persisted, so the goal names nothing, and the back-pointer survives as
//   evidence of what was attempted. A reader listing a goal's orders must read
//   orderIds, not search by goalId.
// - The captured output is the PM's stdout AND stderr interleaved, because
//   runner.write() does not separate them. A CLI that logs progress to stderr
//   therefore has that text scanned for a plan too. Harmless given the
//   extractor only accepts plan-shaped arrays, and it is what makes the
//   non-zero-exit path able to report what the PM actually said.

// Ten megabytes: far above any real plan, far below a runaway transcript.
const CAPTURE_CAP = 10 * 1024 * 1024;

// CSI/OSC sequences only - enough for what a CLI emits, and deliberately not a
// general terminal parser.
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI, '') : '';
}

function logFileFor(root, goalId) {
  return path.join(root, 'logs', `${goalId}.log`);
}

// Names the budget in the refusal below. JSON.stringify is not used for the
// number path: it turns NaN into "null", which reads as an absent cap - the one
// thing this message exists to say it is not.
function describeBudget(budget) {
  if (budget && typeof budget === 'object' && !Array.isArray(budget)) {
    const cap = budget.maxOrdersPerGoal;
    return `maxOrdersPerGoal is ${typeof cap === 'string' ? JSON.stringify(cap) : String(cap)}`;
  }
  // JSON.stringify, except for numbers. String([]) is '' and String([1]) is
  // '1', so an array budget would report as a blank message or as a plain
  // number - and arrays are one of the shapes this refusal exists to name.
  // Numbers are excluded because JSON.stringify(NaN) is "null", which reads as
  // an absent cap: the one thing this message must never imply.
  const shown = typeof budget === 'number' ? String(budget) : JSON.stringify(budget);
  return `the budget is ${shown === undefined ? String(budget) : shown}`;
}

async function decompose(root, { goal, project, agent, childEnv, onChunk }) {
  if (!agent) return goals.failPlanning(root, goal.id, 'no agent available', null);
  if (typeof childEnv !== 'function') {
    // Same contract as dispatch: refusing beats defaulting to process.env,
    // which is the credential leak the allowlist exists to prevent.
    return goals.failPlanning(root, goal.id, 'no child environment policy supplied', null);
  }

  // Refuse a budget that can never accept a plan BEFORE spawning. Finding that
  // out after a fifteen-minute credentialed agent run, having asked the PM for
  // "at most 0 work orders", is the expensive way to learn it.
  //
  // Asked as "would a one-order plan pass?" rather than re-derived from
  // maxOrdersPerGoal, because one order is the smallest plan pm.js can produce
  // - it refuses an empty array - so this is exactly the question "can any plan
  // be accepted?". Re-deriving the rule would mean a second copy of
  // withinBudget's fail-closed table (0, -1, '12', NaN, a non-object budget)
  // kept in step by hand, and a guard that drifts permissive stops guarding
  // without saying so.
  const rawBudget = project ? project.budget : undefined;
  if (!goals.withinBudget(1, rawBudget)) {
    return goals.failPlanning(
      root, goal.id, `${describeBudget(rawBudget)}: no plan can be accepted`, null
    );
  }
  // H4: an unisolated project gets ONE agent at a time, PM included.
  // worktrees.prepare states this in the imperative and records that skipping
  // it actually happened: "a caller that skips that check gets two agents in
  // the user's own tree". dispatch honours it for orders; this is the other
  // spawn path, and it claims from dispatch's pool rather than a second one, so
  // a PM and a dispatched order can see each other. A git project needs nothing
  // - every run gets its own worktree.
  //
  // The check and the claim have NO await between them, exactly as dispatch's
  // do, so they are atomic against another decompose on this event loop - which
  // is the only kind there is.
  //
  // Failed, not refused: an order refused stays `queued` for a scheduler to
  // retry, but nothing retries a goal, and leaving it `planning` is the state
  // only a reboot clears.
  // The day's order budget, asked the same way the goal budget above is: would
  // ONE more order be runnable? A plan produces at least one order - pm.js
  // refuses an empty array - so if the day's cap is already met, nothing this
  // PM could produce would ever dispatch, and spending a fifteen-minute
  // credentialed run to find that out is the expensive way to learn it.
  //
  // `>=` where dispatch.runOrder uses `>`, and the difference is not a slip:
  // runOrder's order is ALREADY persisted when it counts, so `>` cancels that
  // self-inclusion. Nothing is persisted here yet, so the honest question is
  // whether room remains, not whether the cap is exceeded.
  const dailyCap = (project && project.budget && project.budget.maxOrdersPerDay) || 0;
  if (dailyCap && orders.countToday(root, project.id) >= dailyCap) {
    return goals.failPlanning(
      root, goal.id, `daily limit reached (${dailyCap} orders)`, null
    );
  }

  let claimed = false;
  if (project && project.kind !== 'git') {
    if (dispatch.projectBusy(project.id)) {
      return goals.failPlanning(
        root, goal.id,
        'project busy: another agent is already running in this directory, which '
        + 'cannot be isolated', null
      );
    }
    dispatch.claimProject(goal.id, project.id);
    claimed = true;
  }

  // THE CEILING CLAIM, and it must happen HERE - in the same synchronous run as
  // the checks above, with no await between the caller's atCapacity() question
  // and this answer to it. Registering only in planWithClaim (after
  // `await worktrees.prepare`) left a window of tens of milliseconds on a git
  // project - a rev-parse plus a `worktree add` - in which inFlightCount() was
  // 0. Measured: a burst of eight concurrent POST /api/goals on git projects at
  // MAX_CONCURRENT_RUNS=1 answered 200 eight times and ran eight live PMs,
  // where the same burst through /api/orders answered 200,429,429,... and ran
  // one. dispatch has always claimed before its first await; this is the other
  // half of that shape, which was half-copied.
  //
  // It also closes the shutdown corollary: a SIGTERM arriving inside the
  // prepare window found nothing in the map, so cancelAll() returned 0 for a PM
  // that was about to spawn and the 6s hatch exited over it.
  inFlight.set(goal.id, null);
  try {
    return await planWithClaim(root, { goal, project, agent, childEnv, onChunk });
  } finally {
    // AFTER the return expression, so the count only drops once the goal record
    // is written - which is what inFlightCount() promises and what the shutdown
    // drain waits on.
    inFlight.delete(goal.id);
    if (claimed) dispatch.releaseProject(goal.id);
  }
}

async function planWithClaim(root, { goal, project, agent, childEnv, onChunk }) {
  // Safe only because decompose's gate already refused every non-object shape:
  // normalising a malformed budget to {} would hand withinBudget the one answer
  // it refuses to give by accident, which is "unlimited".
  const budget = (project && project.budget) || {};
  const rawBudget = project ? project.budget : undefined;

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
    // ONE assignment to `truncated`, deliberately. The two-branch version of
    // this (append-if-under-cap, else flag) sets the flag in two places, and
    // the branch that fires depends on where a 64KB pipe chunk happens to land
    // relative to the cap - so a run whose LAST chunk straddles the boundary
    // took one path and everything else took the other. One site cannot
    // disagree with itself.
    if (!truncated) {
      captured += chunk;
      if (captured.length > CAPTURE_CAP) {
        captured = captured.slice(0, CAPTURE_CAP);
        truncated = true;
      }
    }
    // The caller's stream is not ours to consume, and it keeps flowing past the
    // cap: CAPTURE_CAP bounds OUR memory, not the caller's view. Plan 3's live
    // log IS this callback, and a run that went quiet at 10MB would look like
    // an agent that stopped rather than one still working.
    if (onChunk) onChunk(chunk);
  };

  let result;
  try {
    const maxOrders = Number.isFinite(budget.maxOrdersPerGoal) ? budget.maxOrdersPerGoal : 12;
    // start(), not run(): run() throws away the cancel handle, and a PM with no
    // handle is invisible to shutdown. Registered BEFORE the await, so a SIGTERM
    // arriving while the promise is pending still finds it.
    const handle = runner.start({
      agent,
      prompt: pm.buildPrompt({ text: goal.text, projectPath: project.path, maxOrders }),
      cwd: wt.cwd,
      logFile: logFileFor(root, goal.id),
      timeoutMs: budget.orderTimeoutMs || 900000,
      // NO_COLOR and TERM=dumb are belt and braces with stripAnsi below: ask
      // the child not to colour, and strip what arrives anyway, because a CLI
      // that ignores both is likelier than a plan that survives one code.
      env: { ...childEnv(agent), NO_COLOR: '1', TERM: 'dumb' },
      onChunk: capture,
    });
    inFlight.set(goal.id, handle);
    result = await handle.done;
  } catch (e) {
    // runner.start throws SYNCHRONOUSLY on an unwritable log directory, and
    // childEnv() and pm.buildPrompt can throw too. dispatch catches exactly
    // this and says why: without it the record is left mid-flight - here,
    // `planning`, which nothing in this plan moves on and only reconcile() at
    // the next boot clears. The caller has to get an outcome, not an exception.
    return goals.failPlanning(root, goal.id, `pm could not start: ${e.message}`, stripAnsi(captured));
  } finally {
    // Back to the claimed-but-no-handle state rather than deleted: the slot is
    // still ours until decompose's finally releases it, and a dead handle left
    // in the map would have cancelAll() cancel a run that already finished.
    inFlight.set(goal.id, null);
    // The PM's worktree is discarded whatever happened - a thrown buildPrompt,
    // a runner that could not open its log, and every failure RETURN below.
    // Unlike an order's, its output is the plan on stdout, not the tree, so
    // there is nothing to preserve and keeping it would leave a branch per goal.
    //
    // cleanup() is written not to throw, so this catch should never fire; it is
    // here because a `finally` that throws REPLACES the outcome, and losing a
    // good plan to a failed rmdir is the worse of the two failures.
    try {
      // The RETURN VALUE is the signal. cleanup() does not throw - it reports
      // { removed: false, preserveError } - so ignoring it means a leaked
      // worktree is completely silent, and the leak is permanent: prepare()'s
      // non-empty guard only fires for the same id, and goal ids never repeat.
      const outcome = await worktrees.cleanup(wt);
      if (wt.isolated) {
        if (outcome.preserveError) {
          console.warn(
            `[plan] ${goal.id}: could not preserve the PM's worktree `
            + `(${outcome.preserveError}); left at ${wt.cwd}`
          );
        } else if (!outcome.removed) {
          console.warn(`[plan] ${goal.id}: worktree not removed; left at ${wt.cwd}`);
        } else if (outcome.committed) {
          // The PM was told "do NOT modify any files". It did anyway, and the
          // branch is kept below so a human can see what.
          console.warn(
            `[plan] ${goal.id}: the PM modified files despite being told not to; `
            + `kept on branch ${wt.branch}`
          );
        } else {
          // Nothing was written, so the branch holds nothing the plan does not.
          // An order's branch is its durable record; a PM's record is the plan
          // on stdout, and a branch per goal is pollution in the user's repo.
          const del = await worktrees.deleteBranch(wt);
          if (del.error) console.warn(`[plan] ${goal.id}: ${wt.branch} left behind: ${del.error}`);
        }
      }
    } catch (e) {
      console.warn(`[plan] could not clean up ${goal.id}'s worktree: ${e.message}`);
    }
  }

  // ANSI colour is the common case, not an edge case: ESC[32m contains a '[',
  // and pm.arraySpans counts brackets - one colour code above the plan swallows
  // it whole and it extracts as "no JSON plan". Measured, not theorised.
  const raw = stripAnsi(captured);
  if (truncated) {
    // A plan that overflowed the cap is almost certainly not a plan. Refusing
    // beats extracting from a half-transcript that happens to parse.
    return goals.failPlanning(
      root, goal.id, `the PM produced more than ${CAPTURE_CAP} characters`, raw
    );
  }
  if (result.error) {
    return goals.failPlanning(root, goal.id, `pm ${result.error}`, raw);
  }
  if (result.exitCode !== 0) {
    return goals.failPlanning(root, goal.id, `pm exited ${result.exitCode}`, raw);
  }

  const { orders: entries, error } = pm.extractPlan(raw);
  if (error) return goals.failPlanning(root, goal.id, error, raw);

  if (!goals.withinBudget(entries.length, rawBudget)) {
    // Refused whole, never truncated, and BEFORE any order is created: spec 8a
    // says running the first 12 of a 30-order plan produces a half-executed
    // goal that looks complete. The plan is kept so the human can narrow the
    // goal rather than guess what was dropped.
    return goals.failPlanning(
      root, goal.id,
      `the plan has ${entries.length} orders, over the limit of ${budget.maxOrdersPerGoal}`,
      raw
    );
  }

  // Re-read the goal before persisting anything. Fifteen minutes can pass
  // inside the run above, and dispatch re-reads its own record after prepare
  // for exactly this reason. Two things can have happened meanwhile:
  //
  //  - the goal is GONE (store.js quarantines a file it cannot parse; a delete
  //    route is the obvious next thing to exist). Creating orders now attaches
  //    them to a goal nothing can find - "orders pointing at no goal are
  //    invisible work that a scheduler may still run", which is what the
  //    rollback below exists to prevent, reached from the other side.
  //  - the goal has SETTLED. goals.patch silently no-ops on a settled record,
  //    so goals.planned would report success while writing nothing, leaving
  //    queued orders carrying the goalId of a goal that already failed.
  const current = goals.get(root, goal.id);
  if (!current) return null;                 // documented in Known limits
  if (current.status !== 'planning') return current;

  // orders.create THROWS on a caller fault, and it is called in a loop after
  // earlier orders of the same plan are already on disk. An uncaught throw here
  // leaves those orphans behind and the goal stuck in `planning`, which only a
  // reboot clears. pm.js welds its limits to orders.js's so this should be
  // unreachable - but "should be unreachable" is not a reason to persist a
  // half-plan when it is not.
  const orderIds = [];
  try {
    entries.forEach((e, seq) => {
      const o = orders.create(root, {
        projectId: project.id,
        prompt: e.prompt,
        title: e.title,
        acceptance: e.acceptance,
      });
      // Recorded BEFORE it is attached, not after. attachToGoal throws on a
      // bad link, and an id pushed afterwards would leave that iteration's
      // order created, `queued`, with goalId null - outside the rollback and
      // invisible to the goal that caused it, which is the exact orphan this
      // catch exists to prevent. Unreachable through this loop today (goal.id
      // is a string and seq is a forEach index), and the rollback should not
      // depend on that staying true.
      orderIds.push(o.id);
      orders.attachToGoal(root, o.id, goal.id, seq);
    });
    // INSIDE the try, so the rollback below covers it. It used to be the last
    // statement of the function, outside every try - and it is a store write,
    // so a goals/ directory that stopped being writable during the run threw
    // AFTER the orders were created and attached. That left exactly what the
    // rollback exists to prevent: queued orders carrying the goalId of a goal
    // that names none of them, invisible work a scheduler may still run.
    // Reproduced, not theorised.
    return goals.planned(root, goal.id, { orderIds, pmAgent: agent.id, rawPlan: raw });
  } catch (e) {
    // Best-effort rollback. A goal pointing at nothing is recoverable; orders
    // pointing at no goal are invisible work that a scheduler may still run.
    // markCancelled takes no reason - lib/orders says why: status already
    // carries the fact, and a second field repeating it can only disagree - so
    // the reason lives on the goal's `error`, which is where a human looks.
    // A rollback that itself fails is not swallowed. If the store is refusing
    // writes, these orders stay `queued` with a goalId pointing at a goal about
    // to be marked failed - the exact invisible work this rollback exists to
    // prevent - and the goal's error is the only place a human would ever see
    // it. Counted rather than listed: the ids are already in the message the
    // goal carries, and a store-wide failure means all of them.
    let stuck = 0;
    for (const id of orderIds) {
      try { orders.markCancelled(root, id); } catch (__) { stuck++; }
    }
    const note = stuck ? ` (${stuck} order(s) could not be cancelled and are still queued)` : '';
    // May itself throw - it writes the same store the failure came from - and
    // that is deliberately not caught: decompose rejects, the caller logs, and
    // the orders above are already cancelled, which is the part that mattered.
    return goals.failPlanning(
      root, goal.id, `could not persist the plan: ${e.message}${note}`, raw
    );
  }
}

module.exports = { decompose, logFileFor, cancelAll, inFlightCount };
