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

const inFlight = new Map(); // orderId -> runner handle, for cancel

function logFileFor(root, orderId) {
  return path.join(root, 'logs', `${orderId}.log`);
}

async function runOrder(root, { order, project, agent, onChunk }) {
  // Cheapest refusals first, so nothing is created for an order we will not run.
  if (!agent) {
    return orders.markFailed(root, order.id, 'no agent available');
  }
  const budget = (project && project.budget) || {};
  const cap = budget.maxOrdersPerDay;
  if (cap && orders.countToday(root, project.id) > cap) {
    return orders.markFailed(root, order.id, `daily limit reached (${cap} orders)`);
  }

  let wt;
  try {
    wt = await worktrees.prepare(root, project, order.id);
  } catch (e) {
    // Fails before any agent spawns, with nothing half-created.
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
    // Always: a failed or cancelled run must not leave a worktree holding a
    // branch. cleanup is a no-op for a dir project.
    await worktrees.cleanup(wt);
  }
}

function cancel(orderId) {
  const handle = inFlight.get(orderId);
  if (!handle) return false;
  handle.cancel();
  return true;
}

module.exports = { runOrder, cancel, logFileFor };
