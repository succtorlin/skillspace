'use strict';

// Attempt chains, and what a goal's chains add up to. PURE: records in,
// answers out - no store, no spawning, no clock - so the rules can be
// table-tested, and lib/scheduler, lib/verdict, lib/attempts and the routes
// all ask the same functions rather than each keeping a copy.
//
// A CHAIN is an order and every order that superseded it, oldest first. Only
// `supersedes` is stored (on the newer order, at creation). supersededBy is
// DERIVED here and never written, because writing it would mutate the attempt
// being replaced - which spec 12 says keeps its status, log and verdict
// permanently.
//
// Known limits:
// - index() trusts the family it is handed. A goal's family is the records its
//   orderIds name (lib/attempts.familyOf) - NOT every record carrying its
//   goalId, because a rolled-back retry keeps its goalId as a back-pointer and
//   would otherwise read as a successor. Hand it the wrong population and the
//   chains are wrong; it cannot tell.
// - A FORK - two orders superseding one - is prevented at creation, not here.
//   Here the oldest successor wins and the other reads as its own chain. Only a
//   hand edit or a second process can make one.

// Far beyond any real chain (maxAttemptsPerOrder caps at 10); exists so a
// hand-edited cycle costs a bounded walk rather than a hung reader.
const MAX_CHAIN = 1000;

function verdictStateOf(o) {
  return o && o.verdictState !== undefined ? o.verdictState : null;
}

// Why this order cannot be judged, or null if it can. ONE predicate for the
// judge, the judge pass, the retry rules and the head classification below.
//
// Judged: a goal order that produced a RESULT - exited 0, exited non-zero, or
// was killed by its timeout (spec 10: "PM still gets the result so a verdict
// exists"). Not judged: an order that never ran (lib/orders' own meaning of a
// failed record with no startedAt), a cancelled or interrupted one (no result
// exists), and an order outside a goal (there is no PM to ask).
function judgeable(o) {
  if (!o || typeof o !== 'object') return 'no order to judge';
  if (typeof o.goalId !== 'string' || !o.goalId) return 'an order outside a goal has no PM to judge it';
  if (o.status === 'succeeded') return null;
  if (o.status === 'failed') {
    return o.startedAt ? null : 'the order never ran, so there is no result to judge';
  }
  return `the order is ${o.status}, so there is no result to judge`;
}

function index(records) {
  const byId = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (r && typeof r.id === 'string') byId.set(r.id, r);
  }
  // Ascending id is creation order: orders.newId embeds the timestamp and a
  // per-process tick precisely so that string order means something.
  const supersededBy = new Map();
  for (const id of [...byId.keys()].sort()) {
    const prev = byId.get(id).supersedes;
    if (typeof prev !== 'string' || prev === id || !byId.has(prev)) continue;
    if (!supersededBy.has(prev)) supersededBy.set(prev, id);
  }

  // `seen` is what keeps a hand-edited cycle from repeating ids; MAX_CHAIN
  // alone would only bound the walk, not keep it correct.
  function chainOf(id) {
    if (!byId.has(id)) return null;
    const ids = [id];
    const seen = new Set(ids);
    let cur = byId.get(id);
    while (ids.length < MAX_CHAIN) {
      const prev = cur.supersedes;
      if (typeof prev !== 'string' || !byId.has(prev) || seen.has(prev)) break;
      ids.unshift(prev);
      seen.add(prev);
      cur = byId.get(prev);
    }
    const at = ids.length - 1;
    let next = supersededBy.get(id);
    while (next && !seen.has(next) && ids.length < MAX_CHAIN) {
      ids.push(next);
      seen.add(next);
      next = supersededBy.get(next);
    }
    return {
      rootId: ids[0],
      headId: ids[ids.length - 1],
      ids,
      attempt: at + 1,
      attempts: ids.length,
      supersedes: at > 0 ? ids[at - 1] : null,
      supersededBy: supersededBy.get(id) || null,
    };
  }

  return { byId, supersededBy, chainOf };
}

// What is left to do at a chain's head:
//   busy      an agent holds it right now - dispatched, or being judged
//   pending   the machine will act without anyone asking: queued, running,
//             awaiting a verdict, or rejected with its retry not yet created
//   verified  done, and the PM agreed
//   rejected  rejected, and no retry is coming (retryRefused says why)
//   stuck     nothing automatic will move it; a human can (verdict error,
//             cancelled, interrupted, never ran)
//   missing   the record cannot be read
//
// An unknown status reads `pending`, which keeps the goal open: a goal must
// never reach `done`, which is settled, over a record nobody understood.
function headState(rec, busy) {
  if (busy) return 'busy';
  if (!rec) return 'missing';
  if (rec.status === 'queued' || rec.status === 'running') return 'pending';
  if (rec.status === 'cancelled' || rec.status === 'interrupted') return 'stuck';
  if (rec.status !== 'succeeded' && rec.status !== 'failed') return 'pending';
  if (rec.status === 'failed' && !rec.startedAt) return 'stuck';
  const vs = verdictStateOf(rec);
  if (vs === 'error') return 'stuck';
  if (vs !== 'judged') return 'pending';
  if (rec.verdict === 'verified') return 'verified';
  if (rec.verdict === 'rejected') return rec.retryRefused ? 'rejected' : 'pending';
  return 'stuck';
}

// What a goal's chains add up to. Returns { status, heads, error? }, or null
// for a goal with nothing to derive from (empty or malformed orderIds) - the
// caller leaves those alone, because "every chain verified" is VACUOUSLY true
// of no chains and `done` is settled.
//
// Precedence, and each step is a decision recorded in the plan:
//   any head busy                     -> running
//   any head pending or missing       -> planned   (outstanding beats failed)
//   every head verified               -> done
//   any head rejected with no retry   -> failed    (beats stuck: cannot succeed)
//   otherwise                         -> stalled
function goalOutcome(goal, byId, isBusy) {
  const ids = goal && Array.isArray(goal.orderIds) ? goal.orderIds : null;
  if (!ids || ids.length === 0) return null;
  const inGoal = new Set(ids);
  const superseded = new Set();
  for (const id of ids) {
    const r = byId.get(id);
    if (r && typeof r.supersedes === 'string' && r.supersedes !== id && inGoal.has(r.supersedes)) {
      superseded.add(r.supersedes);
    }
  }
  const heads = ids
    .filter((id) => !superseded.has(id))
    .map((id) => ({ id, state: headState(byId.get(id), !!(isBusy && isBusy(id))) }));

  const has = (s) => heads.some((h) => h.state === s);
  if (has('busy')) return { status: 'running', heads };
  if (has('pending') || has('missing')) return { status: 'planned', heads };
  if (heads.every((h) => h.state === 'verified')) return { status: 'done', heads };
  const finals = heads.filter((h) => h.state === 'rejected');
  if (finals.length) {
    const first = byId.get(finals[0].id);
    return {
      status: 'failed',
      heads,
      error: `${finals.length} order(s) rejected with no retry coming; first: `
        + `${first.id} (${first.retryRefused}): ${first.verdictReason || 'no reason given'}`,
    };
  }
  return { status: 'stalled', heads };
}

module.exports = { judgeable, verdictStateOf, index, headState, goalOutcome };
