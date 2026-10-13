'use strict';
const fs = require('fs');
const path = require('path');
const orders = require('./orders');
const goals = require('./goals');
const projects = require('./projects');
const worktrees = require('./worktrees');
const runner = require('./runner');
const pm = require('./pm');
const dispatch = require('./dispatch');
const chains = require('./chains');
const { stripAnsi } = require('./plan');

// Runs the PM once more per finished order, as a JUDGE: does the result meet
// that order's own acceptance? Spec 4's last two arrows.
//
// The FIFTH spawn path, and its sibling is lib/plan. Every lesson lib/plan
// records is inherited here on purpose rather than re-learned: the claim is
// taken synchronously, before the first await, in the same run as every
// admission check; a claimed-but-not-spawned judge is cancelled by tombstone;
// intent is re-checked after prepare; the in-flight count drops only after the
// record is written; output is ANSI-stripped by lib/plan's own function and
// capped; the scratch worktree is disposed of by worktrees.discard.
//
// judge() IS NOT ASYNC, and that is the design. Its synchronous prologue IS the
// admission: it answers { refused, kind } or { order, done } before returning,
// with no await between any check and the claim. So the tick and the HTTP
// route - the only two callers - cannot both win, and the route answers 409 or
// 429 from the authority itself rather than from a pre-check that can go stale
// (the dispatch route needed isClaimed() precisely because runOrder is async
// all the way down).
//
// A REFUSAL SETTLES NOTHING. At capacity, project busy, no agent, no policy:
// the record is left exactly as it was and the next tick asks again. Only a
// judge that actually ran and could not produce a verdict writes `error` -
// which nothing automatic will ever retry.
//
// Known limits:
// - A JUDGE RUN IS NOT COUNTED against maxOrdersPerDay, exactly like a PM
//   planning run (lib/plan says why: the cap is derived from order records).
//   It is bounded STRUCTURALLY instead: at most one automatic judgement per
//   order (the loop never re-judges an error), and orders per goal are capped
//   by maxOrdersPerGoal - retries included - so judge runs per goal cannot
//   exceed it. A human clicking verdict/retry is the one unbounded door, and a
//   human is the bound 2a relied on.
// - THE SCRATCH WORKTREE LEAKS ON SIGKILL, like every other spawn path's. Same
//   record-only boot reconcile, same deferred GC (2b item 5).
// - THE JUDGE SEES ~8000 CHARACTERS OF WORKER OUTPUT. On a git project it is
//   told the branch holding the committed work and can read the diff; on a dir
//   project the work is in place. A worker that wrote its result only to
//   stdout, beyond the tail, is judged on less than it said.
// - verdictRaw keeps the LAST 16000 characters of an unreadable reply. The full
//   transcript is the verdict log; this is the copy a board can show without
//   opening a file, and every list() call reads it.

// Same runaway guard as lib/plan's, for the same reason.
const CAPTURE_CAP = 10 * 1024 * 1024;
const RAW_KEEP = 16000;
// Bytes read from the END of the worker log, then trimmed to characters. Read
// as a window rather than the whole file: a worker log has no size bound.
const TAIL_BYTES = 64 * 1024;
const TAIL_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 900000;

// orderId -> runner handle, or null while claimed and not yet spawned.
const inFlight = new Map();
// Claimed-not-spawned judges cancelled by shutdown. lib/plan's tombstone, for
// lib/plan's reason: a null handle cannot be signalled, and skipping it was the
// orphan - 9 of 10 SIGTERM-in-prepare trials, measured there.
const aborted = new Set();

function isJudging(orderId) {
  return inFlight.has(orderId);
}

// Counted into server.js's agentsRunning(), so a judge holds a slot in the
// process ceiling and holds the shutdown drain open until its record is
// written. See judge()'s finally for why the second half is true.
function inFlightCount() {
  return inFlight.size;
}

// Shutdown only, lib/plan's shape exactly.
function cancelAll() {
  let n = 0;
  for (const [orderId, handle] of [...inFlight.entries()]) {
    if (handle) handle.cancel();
    else aborted.add(orderId);
    n++;
  }
  return n;
}

function verdictLogFor(root, orderId, run) {
  return path.join(root, 'logs', `${orderId}.verdict-${run}.log`);
}

// The END of the worker's log, ANSI-free, at most TAIL_CHARS characters. A
// missing log is an empty tail - an order that printed nothing - and is said so
// in the prompt. Any OTHER read failure is said too, rather than shown to the
// judge as "no output", which would be a false statement about the worker.
function logTail(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    // The window can start mid-character; the decoder renders that as U+FFFD,
    // which is noise at the front of a tail and nothing more.
    const text = stripAnsi(buf.toString('utf8')).replace(/^�+/, '');
    const chars = Array.from(text);
    return chars.length > TAIL_CHARS ? chars.slice(-TAIL_CHARS).join('') : text;
  } catch (e) {
    if (e && e.code === 'ENOENT') return '';
    return `(the worker's log could not be read: ${e && e.code ? e.code : String(e)})`;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function keepRaw(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length <= RAW_KEEP) return raw;
  // Drop a lone low surrogate the cut may have left at the front.
  return raw.slice(-RAW_KEEP).replace(/^[\uDC00-\uDFFF]/, '');
}

function refuse(refused, kind) {
  return { refused, kind };
}

// judge(root, { order, goal, project, agent, childEnv, allowFrom })
//   -> { refused, kind }            nothing was claimed or written
//   -> { order, done }              claimed; `order` reads `judging` on disk,
//                                   `done` resolves to the final record (or
//                                   null if it vanished) and rejects only if
//                                   the store cannot be written
//
// kind: 'missing' (no such record), 'capacity' (the ceiling), 'conflict'
// (everything else). The route maps them to 404, 429, 409.
//
// allowFrom is the set of verdictStates admission accepts: [null] for the loop
// (never re-judge an error), [null, 'error'] for a human. 'judging' and
// 'judged' are never admissible: one is in flight, the other is permanent.
function judge(root, { order, goal, project, agent, childEnv, allowFrom } = {}) {
  const from = (Array.isArray(allowFrom) ? allowFrom : [null])
    .filter((s) => s !== 'judging' && s !== 'judged');
  const id = order && order.id;
  if (typeof id !== 'string') return refuse('no order to judge', 'missing');
  // FIRST, above every other gate, for runOrder's reason: a duplicate is a
  // duplicate whatever else is true, and must say so rather than be blamed on
  // capacity.
  if (inFlight.has(id)) return refuse('already being judged', 'conflict');
  const current = orders.get(root, id);
  if (!current) return refuse('no such order', 'missing');
  const why = chains.judgeable(current);
  if (why) return refuse(why, 'conflict');
  const state = chains.verdictStateOf(current);
  if (!from.includes(state)) {
    return refuse(
      state === 'judged' ? `already judged: ${current.verdict}` : `the verdict is ${state === null ? 'not yet attempted' : state}`,
      'conflict'
    );
  }
  if (!goal || goal.id !== current.goalId) return refuse("the order's goal cannot be read", 'conflict');
  // orderIds is AUTHORITATIVE; goalId is a back-pointer that survives a
  // rollback (lib/plan, lib/attempts). An order its goal does not name is a
  // rolled-back attempt, and judging it would spend a run on work no goal
  // counts.
  if (!Array.isArray(goal.orderIds) || !goal.orderIds.includes(id)) {
    return refuse("the order is not part of its goal's plan", 'conflict');
  }
  if (goals.SETTLED.has(goal.status) || goal.status === 'planning') {
    return refuse(`the goal is ${goal.status}`, 'conflict');
  }
  if (!project || project.id !== current.projectId) return refuse("the order's project cannot be read", 'conflict');
  if (!agent || typeof agent !== 'object') return refuse('no agent available', 'conflict');
  if (typeof childEnv !== 'function') return refuse('no child environment policy supplied', 'conflict');
  if (dispatch.atCapacity()) return refuse('at capacity', 'capacity');
  if (project.kind !== 'git' && dispatch.projectBusy(project.id)) return refuse('project busy', 'conflict');

  // THE CLAIM. No await above this line, none until after it.
  const run = (Number.isInteger(current.verdictRuns) ? current.verdictRuns : 0) + 1;
  const logFile = verdictLogFor(root, id, run);
  // 'vrd-' cannot collide with lib/plan's 'goal-' keys or runOrder's 'ord-' ids
  // in dispatch's projectOf map - dispatch reads keys as opaque handles.
  const claimKey = `vrd-${id}`;
  const holdsDir = project.kind !== 'git';
  inFlight.set(id, null);
  if (holdsDir) dispatch.claimProject(claimKey, project.id);
  const release = () => {
    inFlight.delete(id);
    aborted.delete(id);
    if (holdsDir) dispatch.releaseProject(claimKey);
  };

  let marked;
  try {
    // Persisted at claim time, so a restart can tell an interrupted judgement
    // from one never attempted (orders.reconcileVerdicts).
    marked = orders.recordVerdict(root, id, {
      verdictState: 'judging',
      verdictRuns: run,
      verdictAgent: typeof agent.id === 'string' ? agent.id : null,
      verdictLog: logFile,
      verdictStartedAt: new Date().toISOString(),
      verdictError: null,
      verdictRaw: null,
      verdictAt: null,
    });
  } catch (e) {
    // The store refused the claim's record. Nothing can be recorded, including
    // a failure - so the throw propagates, as runOrder's markRunning does.
    release();
    throw e;
  }
  if (!marked || marked.verdictState !== 'judging') {
    release();
    return refuse('the order changed while it was being claimed', 'conflict');
  }

  const done = (async () => {
    try {
      return await runJudge(root, { order: marked, project, agent, childEnv, run, logFile });
    } finally {
      // AFTER the awaited return value, which is the record write - so the
      // count reaches zero only once the outcome is on disk. lib/plan's shutdown
      // lesson, kept.
      release();
    }
  })();
  return { order: marked, done };
}

async function runJudge(root, { order, project, agent, childEnv, run, logFile }) {
  const fail = (message, raw) => orders.recordVerdict(root, order.id, {
    verdictState: 'error',
    verdictError: message,
    verdictRaw: keepRaw(raw),
    verdictAt: new Date().toISOString(),
  });

  let wt;
  try {
    // A scratch worktree of its own, NOT the order's: the judge is told not to
    // modify anything, which is a hope, and a worktree makes it true. On a git
    // project it shares refs with the repo, so the order's branch is readable.
    wt = await worktrees.prepare(root, project, `vrd-${order.id}-${run}`);
  } catch (e) {
    return fail(`worktree: ${e.message}`, null);
  }

  let captured = '';
  let truncated = false;
  const capture = (chunk) => {
    // One assignment to `truncated`; lib/plan says why.
    if (truncated) return;
    captured += chunk;
    if (captured.length > CAPTURE_CAP) {
      captured = captured.slice(0, CAPTURE_CAP);
      truncated = true;
    }
  };

  let result;
  try {
    // INTENT, after prepare and before a spawn nothing could then stop. No
    // await from here to runner.start, so a cancelAll landing after this check
    // finds a real handle instead - the two windows meet with no gap.
    if (aborted.has(order.id)) return fail('the judge was cancelled before it started', null);
    const before = orders.get(root, order.id);
    if (!before) return null;
    if (before.verdictState !== 'judging' || before.verdictRuns !== run) return before;

    const budget = project.budget || {};
    const handle = runner.start({
      agent,
      prompt: pm.buildVerdictPrompt({
        order: before,
        logTail: logTail(dispatch.logFileFor(root, order.id)),
        workBranch: project.kind === 'git' ? worktrees.branchFor(order.id) : null,
      }),
      cwd: wt.cwd,
      logFile,
      timeoutMs: budget.orderTimeoutMs || DEFAULT_TIMEOUT_MS,
      env: { ...childEnv(agent), NO_COLOR: '1', TERM: 'dumb' },
      onChunk: capture,
    });
    inFlight.set(order.id, handle);
    result = await handle.done;
  } catch (e) {
    return fail(`the judge could not start: ${e.message}`, stripAnsi(captured));
  } finally {
    // Back to claimed-without-a-handle, not deleted: the slot is ours until
    // judge()'s finally, and a dead handle would have cancelAll() cancel a run
    // that already finished.
    inFlight.set(order.id, null);
    try {
      const { warning } = await worktrees.discard(wt);
      if (warning) console.warn(`[verdict] ${order.id}: ${warning}`);
    } catch (e) {
      console.warn(`[verdict] could not clean up ${order.id}'s judge worktree: ${e.message}`);
    }
  }

  const raw = stripAnsi(captured);
  if (truncated) return fail(`the judge produced more than ${CAPTURE_CAP} characters`, raw);
  // A judge that timed out, was cancelled, or never spawned has said nothing,
  // whatever it printed first.
  if (result.error) return fail(`the judge's run ended: ${result.error}`, raw);
  if (result.exitCode !== 0) return fail(`the judge exited ${result.exitCode}`, raw);

  const v = pm.extractVerdict(raw);
  if (v.error) return fail(v.error, raw);

  // Re-read before the write that matters: a run can take the whole
  // orderTimeoutMs, and this is the record's permanent answer.
  const current = orders.get(root, order.id);
  if (!current) return null;
  if (current.verdictState !== 'judging' || current.verdictRuns !== run) return current;
  return orders.recordVerdict(root, order.id, {
    verdictState: 'judged',
    verdict: v.verdict,
    verdictReason: v.reason,
    verdictError: null,
    verdictRaw: null,
    verdictAt: new Date().toISOString(),
  });
}

// When `done` REJECTS - the store failed mid-run - the record still reads
// `judging` with no claim behind it, which lib/chains reads as "awaiting a
// verdict": a goal stalled at `planned` forever, silently. Best-effort error
// write, shared by the loop and the route so neither forgets it.
function recordCrash(root, orderId, e) {
  try {
    orders.recordVerdict(root, orderId, {
      verdictState: 'error',
      verdictError: `judge: ${e && e.message ? e.message : String(e)}`,
      verdictAt: new Date().toISOString(),
    });
  } catch (_) { /* the store is what failed; the caller logs */ }
}

function needsVerdict(o) {
  return chains.judgeable(o) === null && chains.verdictStateOf(o) === null;
}

// The judge pass, called by lib/scheduler's tick with the tick's snapshot.
// Oldest first, for the dispatch pass's reason. EVERY check here SHADOWS one
// in judge() and exists only to skip pointless work (a store read, a judgeFor
// call) - judge() is the authority, for this pass and for the HTTP route alike.
// A mutation sweep says so: deleting the settled-goal check here, or admitting
// an errored verdict into needsVerdict, changes nothing observable, because
// judge() refuses both. The rules that matter are pinned against judge() in
// test/verdict.test.js: a goal settled before plan 2d existed must not have its
// whole history judged on first boot, and an order its goal does not name is
// never judged.
//
// One candidate's fault is one candidate's fault (scheduler.js, 2c).
function pass(root, { all, goalsById, judgeFor, childEnv, onError }) {
  const counts = { offered: 0, refused: 0 };
  const projectCache = new Map();
  const queue = all.filter(needsVerdict).reverse();
  for (const order of queue) {
    if (dispatch.atCapacity()) break;
    if (inFlight.has(order.id)) continue;
    try {
      const goal = goalsById.get(order.goalId);
      if (!goal || goals.SETTLED.has(goal.status) || goal.status === 'planning') continue;
      // orderIds is authoritative; a goalId is only a back-pointer that
      // survives a rollback.
      if (!Array.isArray(goal.orderIds) || !goal.orderIds.includes(order.id)) continue;
      if (!projectCache.has(order.projectId)) projectCache.set(order.projectId, projects.get(root, order.projectId));
      const project = projectCache.get(order.projectId);
      if (!project) continue;
      if (project.kind !== 'git' && dispatch.projectBusy(project.id)) continue;
      // "Not now", exactly as agentFor's absent answer is in the dispatch pass.
      const agent = judgeFor(goal, project);
      if (!agent || typeof agent !== 'object') continue;
      const r = judge(root, { order, goal, project, agent, childEnv });
      if (r.refused) {
        counts.refused += 1;
        continue;
      }
      counts.offered += 1;
      r.done.catch((e) => {
        recordCrash(root, order.id, e);
        onError(e, `judging order ${order.id}`);
      });
    } catch (e) {
      onError(e, `considering order ${order.id} for a verdict`);
    }
  }
  return counts;
}

module.exports = {
  judge, pass, isJudging, inFlightCount, cancelAll, logTail, recordCrash, verdictLogFor,
};
