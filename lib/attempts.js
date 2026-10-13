'use strict';
const orders = require('./orders');
const goals = require('./goals');
const projects = require('./projects');
const chains = require('./chains');

// A rejected order is never re-run (spec 12): it is SUPERSEDED by a new order
// carrying the same instruction plus the reviewer's reason. This module is the
// only place that happens, for both doors - the scheduler's retry pass
// (origin 'verdict') and POST /api/orders/:id/retry (origin 'human') - which
// differ in exactly one rule: a human is not bounded by maxAttemptsPerOrder.
//
// supersede() IS SYNCHRONOUS END TO END. Its uniqueness check and the create
// that acts on it have no await between them, so the tick and a request cannot
// both supersede one order. That is the whole concurrency story here, and it
// holds only while nothing in this function awaits.
//
// HOW RETRIES COUNT, and why (plan decision 6):
//   maxAttemptsPerOrder  automatic only; reaching it is FINAL
//   maxOrdersPerGoal     every attempt counts; reaching it is FINAL. A retry
//                        that did not count would make the real bound
//                        plan-size x attempts - a cap quietly not a cap
//   maxOrdersPerDay      every attempt counts; reaching it DEFERS - tomorrow
//                        it runs, as the scheduler treats any queued backlog
//
// Refusal kinds: 'missing' (no record), 'conflict' (the state does not allow
// it), 'limit' (the daily cap - try later), 'final' (this chain is over; the
// retry pass records it as retryRefused). Routes map them to 404/409/429/409.
//
// Known limits:
// - THE FAMILY OF A GOAL ORDER IS ITS GOAL'S orderIds, not every record with
//   its goalId. A rollback below leaves a cancelled order carrying both a
//   goalId and a supersedes; reading by goalId would make it a successor and
//   block every later retry of the order it names. Pinned.
// - A rollback that itself fails leaves a QUEUED retry the goal does not name.
//   The dispatch pass would still run it (it carries a goalId), and the
//   per-goal budget would not count it - the same "invisible work" lib/plan's
//   rollback names, reached only when the store refuses writes mid-sequence.
//   Not chased further for the same reason lib/plan does not.
// - The daily-cap check opens every order record of the project
//   (orders.countToday), once per candidate the retry pass offers. Invisible
//   at tens of orders; the index lib/orders already names is the fix.

const PLAIN_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

// The cap a project allows for AUTOMATIC attempts. Fails closed in the
// direction that spends less: a present-but-unusable value is ONE attempt (no
// automatic retry), never "unlimited". An ABSENT value is the default, because
// every project created before plan 2d lacks the key and reading that as "no
// retries ever" would silently disable the feature for every existing user -
// the opposite trade from lib/goals.withinBudget, where absence means
// unlimited and so had to be read literally.
function attemptCap(project) {
  const budget = project ? project.budget : undefined;
  const fallback = projects.DEFAULT_BUDGET.maxAttemptsPerOrder;
  if (budget === undefined || budget === null) return fallback;
  if (typeof budget !== 'object' || Array.isArray(budget)) return 1;
  const cap = budget.maxAttemptsPerOrder;
  if (cap === undefined || cap === null) return fallback;
  if (!Number.isInteger(cap) || cap < 1) return 1;
  return Math.min(cap, projects.BUDGET_MAX.maxAttemptsPerOrder);
}

// The ORIGINAL instruction, untouched, then the feedback. Appended to the
// rejected attempt's prompt - which already carries any earlier feedback - so
// attempt 3 sees both reasons in the order they were given.
function withFeedback(prompt, attempt, reason) {
  return [
    prompt,
    '',
    '---',
    `REVIEWER FEEDBACK ON ATTEMPT ${attempt}`,
    `A reviewer judged attempt ${attempt} of this order against its acceptance criteria and rejected it:`,
    reason,
    `This is attempt ${attempt + 1}. The acceptance criteria have not changed; address the feedback.`,
  ].join('\n');
}

function refuse(refused, kind, extra) {
  return { refused, kind, ...(extra || {}) };
}

// The records an order's chain is read from, or null if the order is not part
// of its goal's plan (a rollback orphan, or a goal that cannot be read).
function familyOf(root, order, goal) {
  if (order.goalId) {
    if (typeof order.goalId !== 'string' || !PLAIN_ID.test(order.goalId)) return null;
    const g = goal !== undefined ? goal : goals.get(root, order.goalId);
    if (!g || !Array.isArray(g.orderIds) || !g.orderIds.includes(order.id)) return null;
    return g.orderIds
      .filter((id) => typeof id === 'string' && PLAIN_ID.test(id))
      .map((id) => orders.get(root, id))
      .filter(Boolean);
  }
  return orders.list(root, { projectId: order.projectId }).filter((o) => !o.goalId);
}

function chainFor(root, order) {
  const family = order ? familyOf(root, order) : null;
  return family ? chains.index(family).chainOf(order.id) : null;
}

// Chains for a page of records, one goal read per goal rather than per record.
// Records whose family cannot be established map to null rather than to a
// chain that would be wrong.
function chainMap(root, records) {
  const out = {};
  const byGoal = new Map();
  const loose = [];
  for (const r of records) {
    if (!r.goalId) loose.push(r);
    else if (byGoal.has(r.goalId)) byGoal.get(r.goalId).push(r);
    else byGoal.set(r.goalId, [r]);
  }
  for (const [goalId, recs] of byGoal) {
    const g = typeof goalId === 'string' && PLAIN_ID.test(goalId) ? goals.get(root, goalId) : null;
    const named = new Set(g && Array.isArray(g.orderIds) ? g.orderIds : []);
    const idx = chains.index(recs.filter((r) => named.has(r.id)));
    for (const r of recs) out[r.id] = named.has(r.id) ? idx.chainOf(r.id) : null;
  }
  const idx = chains.index(loose);
  for (const r of loose) out[r.id] = idx.chainOf(r.id);
  return out;
}

function supersede(root, { orderId, origin } = {}) {
  if (origin !== 'verdict' && origin !== 'human') {
    throw new Error(`origin must be 'verdict' or 'human', got ${JSON.stringify(origin)}`);
  }
  const human = origin === 'human';
  const original = orders.get(root, orderId);
  if (!original) return refuse('no such order', 'missing');
  if (!orders.SETTLED.has(original.status)) return refuse(`the order is still ${original.status}`, 'conflict');
  if (original.verdict === 'verified') return refuse('the order was verified; there is nothing to retry', 'conflict');
  const vs = chains.verdictStateOf(original);
  // The loop's door first: it has exactly one reason to be here.
  if (!human && (vs !== 'judged' || original.verdict !== 'rejected')) {
    return refuse('only a rejected verdict is retried automatically', 'conflict');
  }
  if (vs === 'judging') return refuse('the order is being judged', 'conflict');
  // A human retrying an order the PM has not judged yet would race the judge
  // and throw away a verdict that is on its way. An ERRORED verdict is
  // different - nothing will ever judge it - so a human may retry past it.
  if (vs === null && chains.judgeable(original) === null) {
    return refuse('the order is awaiting its verdict', 'conflict');
  }

  const project = projects.get(root, original.projectId);
  if (!project) return refuse("the order's project no longer exists", 'conflict');

  let goal = null;
  if (original.goalId) {
    goal = PLAIN_ID.test(original.goalId) ? goals.get(root, original.goalId) : null;
    if (!goal) return refuse("the order's goal cannot be read", 'conflict');
    if (goals.SETTLED.has(goal.status) || goal.status === 'planning') {
      return refuse(`the goal is ${goal.status}`, 'conflict');
    }
  }
  const family = familyOf(root, original, goal || undefined);
  if (!family) return refuse("the order is not part of its goal's plan", 'conflict');
  const idx = chains.index(family);
  const already = idx.supersededBy.get(original.id);
  if (already) return refuse(`already superseded by ${already}`, 'conflict', { supersededBy: already });
  const attempt = idx.chainOf(original.id).attempt;

  if (!human) {
    const cap = attemptCap(project);
    if (attempt >= cap) return refuse(`no attempts left (${attempt} of ${cap})`, 'final');
  }
  if (goal) {
    if (!goals.withinBudget(goal.orderIds.length + 1, project.budget)) {
      const cap = project.budget && project.budget.maxOrdersPerGoal;
      return refuse(`the goal has used its ${cap} orders`, 'final');
    }
  }
  // `>=`, lib/plan's comparison and for its reason: nothing is persisted yet,
  // so the question is whether room remains.
  const daily = project.budget && project.budget.maxOrdersPerDay;
  if (daily && orders.countToday(root, project.id) >= daily) {
    return refuse(`daily limit reached (${daily} orders)`, 'limit');
  }

  const prompt = original.verdict === 'rejected'
    ? withFeedback(original.prompt, attempt, original.verdictReason || '(no reason was recorded)')
    : original.prompt;
  if (prompt.length > orders.MAX_PROMPT) {
    return refuse(`the retry's prompt would be ${prompt.length} characters, over the limit of ${orders.MAX_PROMPT}`, 'final');
  }

  let made = null;
  try {
    made = orders.create(root, {
      projectId: project.id,
      prompt,
      title: original.title,
      acceptance: original.acceptance,
      supersedes: original.id,
    });
    if (goal) {
      orders.attachToGoal(root, made.id, goal.id, Number.isInteger(original.seq) ? original.seq : 0);
      const g = goals.addOrder(root, goal.id, made.id);
      if (!g || !Array.isArray(g.orderIds) || !g.orderIds.includes(made.id)) {
        orders.markCancelled(root, made.id);
        return refuse(`the goal is ${g ? g.status : 'gone'}`, 'conflict');
      }
    }
  } catch (e) {
    if (made) {
      try { orders.markCancelled(root, made.id); } catch (_) {}
    }
    throw e;
  }
  return { order: orders.get(root, made.id) };
}

// The retry pass, called by lib/scheduler's tick. Every rejected, judged,
// not-yet-refused goal order whose goal does not already name a successor gets
// one supersede(). A FINAL refusal is written as retryRefused - which is what
// lets lib/chains tell "rejected, retry coming" from "rejected, over" across a
// restart. Anything else (the daily cap, a transient conflict) is left for the
// next tick, recording nothing.
//
// The successor check here is ADVISORY - supersede() re-checks against a fresh
// read - and exists so a long-settled chain is not re-read every tick. It
// counts a successor only if its goal names it, for familyOf's reason.
function pass(root, all, goalsById, onError) {
  const counts = { created: 0, final: 0, deferred: 0 };
  const taken = new Set();
  for (const o of all) {
    if (typeof o.supersedes !== 'string' || !o.goalId) continue;
    const g = goalsById.get(o.goalId);
    if (g && Array.isArray(g.orderIds) && g.orderIds.includes(o.id)) taken.add(o.supersedes);
  }
  for (const o of all) {
    if (o.verdict !== 'rejected' || chains.verdictStateOf(o) !== 'judged' || o.retryRefused) continue;
    if (!o.goalId || taken.has(o.id)) continue;
    const g = goalsById.get(o.goalId);
    if (!g || goals.SETTLED.has(g.status) || g.status === 'planning') continue;
    try {
      const r = supersede(root, { orderId: o.id, origin: 'verdict' });
      if (r.order) counts.created += 1;
      else if (r.kind === 'final') {
        orders.recordVerdict(root, o.id, { retryRefused: r.refused });
        counts.final += 1;
      } else counts.deferred += 1;
    } catch (e) {
      onError(e, `retrying order ${o.id}`);
    }
  }
  return counts;
}

module.exports = { supersede, pass, attemptCap, withFeedback, familyOf, chainFor, chainMap };
