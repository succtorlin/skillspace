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
//   this plan, because nothing yet watches them finish. reconcile() therefore
//   leaves a `running` goal alone: its orders are reconciled individually by
//   lib/orders, and nothing here can say whether the goal as a whole finished.
// - list() opens every goal file on every call, exactly like lib/orders. Fine
//   at tens; an index belongs with the board's polling, not here.
// - A wrong-shape record is dropped by usable() without the once-per-id warning
//   lib/orders carries. Deliberate for now — nothing polls goals yet, so there
//   is no log to bury. If a board starts polling list(), copy that warning over.
// - A goal's orderIds are stored, not validated: nothing here checks that each
//   id names an order that exists. lib/plan.js writes the orders first, so the
//   ids are real by construction, and re-reading them here would make this
//   module depend on lib/orders for no gain.

const SUB = 'goals';
const MAX_TEXT = 100000; // matches an order's prompt: goals can carry a lot
const MAX_ID = 200;
// Terminal states. A settled goal is never rewritten, for the same reason an
// order is not: a late writer would erase why it really ended.
const SETTLED = new Set(['done', 'failed']);

// Same scheme as orders, and the same reason: createdAt is only
// millisecond-resolution and two goals created back to back routinely share
// one, which leaves "newest first" to fall through to a random UUID. The
// timestamp prefix plus a per-process tick records creation order in the id
// itself. Zero-padded so string comparison matches numeric order; the tick
// resets on a new millisecond so it cannot wrap inside one.
let lastMs = 0;
let tick = 0;

function newId() {
  const now = Date.now();
  if (now === lastMs) tick++;
  else { lastMs = now; tick = 0; }
  return 'goal-' + String(now).padStart(14, '0') + String(tick).padStart(4, '0')
    + '-' + crypto.randomUUID();
}

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
    projectId: requiredText(src.projectId, 'projectId', MAX_ID),
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

// store.js quarantines unparseable records so one bad file cannot stop the app
// booting. A record that parses but has the wrong shape defeats that: it
// reaches the sort below and throws, and reconcile() is the boot path.
function usable(g) {
  return !!g && typeof g === 'object' && !Array.isArray(g)
    && typeof g.id === 'string' && typeof g.createdAt === 'string';
}

function list(root, filter) {
  const f = filter || {};
  const all = store.list(root, SUB).map((id) => get(root, id)).filter(usable);
  const picked = f.projectId ? all.filter((g) => g.projectId === f.projectId) : all;
  // Newest first. createdAt is millisecond-resolution and rapid pairs share
  // one, so the id breaks the tie — it embeds newId()'s monotonic tick, the
  // only record of order within a millisecond.
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
    // Copied, not aliased: the caller's array must not keep mutating the
    // record it already handed over.
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
//
// A cap is honoured literally whenever one is numeric, including 0 and
// negatives. Only a missing or non-numeric cap means unlimited. Reading a
// mis-typed cap as "unlimited" would silently switch the ceiling off, which is
// the exact failure this function exists to prevent; refusing loudly is
// recoverable, a silently disabled budget is not.
function withinBudget(count, budget) {
  if (!Number.isInteger(count) || count < 1) return false; // an empty plan is not a plan
  const cap = (budget || {}).maxOrdersPerGoal;
  if (!Number.isFinite(cap)) return true;
  return count <= cap;
}

// On boot, a goal still `planning` lost the PM that was decomposing it. Only
// `planning` is orphaned by a restart — see the Known limits note on `running`.
//
// This is the one write that bypasses patch(), deliberately: patch() refuses to
// move a settled goal and 'failed' IS settled, so routing this through it would
// make reconcile a no-op the moment it mattered. Every goal it touches is by
// definition still live, so the rule patch() enforces is not in question here.
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
