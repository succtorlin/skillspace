'use strict';
const path = require('path');
const goals = require('./goals');
const orders = require('./orders');
const worktrees = require('./worktrees');
const runner = require('./runner');
const pm = require('./pm');

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
// - A cleanup failure is warned about and does not fail the goal: the plan is
//   already on stdout by then, and losing it to a leaked directory would be the
//   worse trade. The leak is visible - prepare() refuses to reuse a non-empty
//   worktree - so the next goal fails loudly rather than overwriting it.
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
  // Safe only because the gate above already refused every non-object shape:
  // normalising a malformed budget to {} would hand withinBudget the one answer
  // it refuses to give by accident, which is "unlimited".
  const budget = rawBudget || {};

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
    result = await runner.run({
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
  } finally {
    // The PM's worktree is discarded whatever happened - a thrown buildPrompt,
    // a runner that could not open its log, and every failure RETURN below.
    // Unlike an order's, its output is the plan on stdout, not the tree, so
    // there is nothing to preserve and keeping it would leave a branch per goal.
    //
    // cleanup() is written not to throw, so this catch should never fire; it is
    // here because a `finally` that throws REPLACES the outcome, and losing a
    // good plan to a failed rmdir is the worse of the two failures.
    try {
      await worktrees.cleanup(wt);
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
  } catch (e) {
    // Best-effort rollback. A goal pointing at nothing is recoverable; orders
    // pointing at no goal are invisible work that a scheduler may still run.
    // markCancelled takes no reason - lib/orders says why: status already
    // carries the fact, and a second field repeating it can only disagree - so
    // the reason lives on the goal's `error`, which is where a human looks.
    for (const id of orderIds) {
      try { orders.markCancelled(root, id); } catch (__) {}
    }
    return goals.failPlanning(root, goal.id, `could not persist the plan: ${e.message}`, raw);
  }

  return goals.planned(root, goal.id, { orderIds, pmAgent: agent.id, rawPlan: raw });
}

module.exports = { decompose, logFileFor };
