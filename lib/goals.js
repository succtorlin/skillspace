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
// - `failed` now has TWO writers with two meanings, and `error` says which:
//   failPlanning (the PM could not produce a plan; from `planning` only) and
//   markFailed (an order chain was rejected with no retry coming; from a state
//   that has orders only). Both settle; neither is ever walked back.
// - NOTHING HERE VERIFIES THE CLAIMS `running` AND `done` MAKE. This module
//   never reads lib/orders - a goal's record cannot see an order - so
//   markRunning and markDone RECORD a caller's judgement rather than check it.
//   markDone in particular does NOT confirm that every id in orderIds has
//   settled; the name says "mark". Whoever looked at the orders owns the truth
//   of it, and this module owns only which transitions are legal.
// - reconcile() demotes a `running` goal to `planned` and does NOT count it.
//   The number it returns is the number of goals it FAILED, because that is
//   what server.js prints - "reconciled N interrupted goal(s)" - and a demoted
//   goal was not interrupted: it kept its plan and every order it names. So a
//   boot that corrects fifty stale `running` goals can still log nothing. That
//   is chosen, not overlooked.
// - If reconcile() throws part-way, server.js warns and boots anyway, so every
//   goal it had not yet reached keeps a stale `running` and reads as work in
//   flight that is not. The next successful boot corrects it. Nothing on the
//   READ path second-guesses a persisted status, deliberately: translating
//   `running` to `planned` inside get() was the other candidate for this job,
//   and it would have made markRunning's write unobservable through the only
//   reader anyone has - leaving this module's own writer silently a no-op, and
//   needing a per-record flag on every future goal to say "not from 2b".
// - BOOT LEAVES GOAL STATE STALE RELATIVE TO ORDERS, AND NOTHING RESYNCS IT.
//   Whoever writes the scheduler: read this one twice. A `running` goal is
//   demoted to `planned` on boot, but lib/orders.reconcile settled that goal's
//   orders one step earlier - so a goal can come out of boot reading `planned`
//   with every order it names ALREADY SETTLED. Measured, not theorised: a goal
//   naming o1 (`running`) and o2 (`succeeded`), process killed, boot settles o1
//   to `interrupted` and demotes the goal; the goal now claims work outstanding
//   with nothing outstanding.
//
//   A scheduler that only reacts to settlement events NEVER FIXES THAT GOAL.
//   Every order settled during boot, before the scheduler existed, so no
//   further settlement event will ever fire for it and markDone is never
//   reached. That is the same lie this state machine was built to remove -
//   twenty goals claiming work with zero agents alive - moved one state to the
//   left and reachable by a single restart. So the scheduler must SWEEP every
//   `planned` goal once at startup and reconcile it against its orders, not
//   merely subscribe to transitions.
//
//   Not fixed here and not fixable here: this module deliberately never reads
//   lib/orders, which is what keeps a goal's record from having to know what an
//   order is. The sweep belongs to whoever can see both.
// - reconcile() IS BOOT-ONLY AND NOTHING ENFORCES THAT. Whoever writes the
//   scheduler: this one is addressed to you. The demotion is unconditional and
//   uncounted, so calling reconcile() from a scheduler that is already running
//   would rewrite every genuinely `running` goal to `planned` and return 0 - no
//   throw, no log, no count to notice it by. reconcile() is not a resync.
//   If what you want is "this goal's last in-flight order just settled", that
//   is markPlanned(): one goal, through patch(), guarded at both ends.
//
//   Left unguarded after weighing three shapes, not because no guard could
//   work. A demote-by-default parameter protects nobody who does not already
//   know to pass it. Defaulting it OFF means the migration stops the moment
//   server.js's single call is edited, silently resurrecting the bug this state
//   machine exists to fix - failing closed on a correction is not failing safe.
//   A module-level once-flag breaks every test that reconciles two roots in one
//   process.
//
//   A per-root in-process Set survives both of those and is the closest call:
//   no parameter to forget, distinct roots each still demote, and the scheduler
//   runs in the server's own process so it would be caught. It loses on SCOPE.
//   The hazard is not the demotion, it is calling reconcile() off the boot path
//   at all - the same call also FAILS every `planning` goal, settling a goal a
//   live PM is still decomposing into a state nothing can walk back, which is
//   the worse half and predates this change. A guard over the demotion alone
//   fixes the lesser half while making the whole function look safe to call:
//   the same defect as a comment promising what the code does not do. Guarding
//   both halves makes reconcile() refuse a second legitimate call. And
//   lib/orders.reconcile carries the identical hazard in a worse form - it
//   force-settles live orders to `interrupted` - has been documentation-only
//   since 2b, and is at least louder, because it returns a count server.js
//   prints.
// - markRunning/markPlanned/markDone have NO production caller yet. Task 4's
//   scheduler is the named consumer; they exist now because this is the change
//   that fixes the vocabulary, and defining it from the plan that has no
//   scheduler was the thing 2b deliberately refused to do. Unreached code with
//   a named consumer, not dead code - do not sweep them as unused.
// - moveLive() REWRITES ON A NO-OP TRANSITION. markRunning on a goal already
//   `running` re-enters patch() and writes a byte-identical record - mkdir,
//   write, rename. A scheduler polling per in-flight order per tick would
//   rewrite every goal's file every tick with unchanged data. The per-tick READ
//   cost is the next entry; this is the write half of the same bill. Not
//   short-circuited here because it cannot be done generically: markDone also
//   stamps finishedAt, so `changes.status === g.status` is not the same
//   question as "this write changes nothing". A polling caller should track
//   what it last wrote.
// - A record whose `status` is ABSENT OR MISSPELLED is live forever to the
//   three movers. usable() validates only id and createdAt, so it survives into
//   list(); reconcile() matches neither branch (`=== 'running'` is false,
//   `!== 'planning'` is true); and HAS_ORDERS.has(undefined) is false, so
//   markRunning, markPlanned and markDone are all permanent silent no-ops on
//   it. planned() and failPlanning() CAN still move it - they go straight
//   through patch(), which asks only whether the status is SETTLED. Verified
//   against both an absent status and a misspelt one. Mirrors lib/orders'
//   usable() and predates the movers; recorded because this change adds three
//   writers that look like they should work on such a record and do not.
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
// The states, and what each one actually claims:
//
//   planning  the PM is decomposing. Swept to `failed` on boot - nothing
//             survives a restart mid-decomposition.
//   planned   a plan is on disk and orders exist, and none of them is in
//             flight. NOT work in progress. This is what `running` used to
//             mean up to plan 2b, where it was set at plan-persist time with
//             every order still `queued` - so twenty planned goals read as
//             twenty running goals with zero agents alive, and nothing ever
//             moved them: reconcile skipped `running`, SETTLED did not contain
//             it, and no other writer existed.
//   running   at least one of this goal's orders is in flight right now.
//   stalled   every order this goal names has stopped, none was finally
//             rejected, and at least one needs a HUMAN: a verdict that could
//             not be read, or an attempt that was cancelled, interrupted or
//             never started. LIVE, not settled - POST /api/orders/:id/retry
//             and .../verdict/retry are how it moves, and a settled goal
//             would refuse both. reconcile() leaves it alone: nothing in it
//             was in flight.
//   done      every order chain's latest attempt was VERIFIED. [SETTLED]
//   failed    the PM could not produce a usable plan, OR an order chain was
//             rejected with no retry coming.                  [SETTLED]
//
// `planned` and `running` both mean work is outstanding, which is why
// reconcile() FAILS neither. It does move `running` back to `planned`, because
// on boot the claim `running` makes is false of every goal in the store.

// Terminal states. A settled goal is never rewritten, for the same reason an
// order is not: a late writer would erase why it really ended.
const SETTLED = new Set(['done', 'failed']);

// The other end of the rule patch() enforces at the settled end. A goal reaches
// `running` or `done` only from a state that HAS orders: `planning` means the
// PM has not produced any, so "at least one of its orders is in flight" is
// false of it and "every order it names has settled" is VACUOUSLY true - which
// is the worse half, because it settles a goal that did nothing and a settled
// record is never rewritten. Moving a `planning` goal directly would also skip
// planned(), the one writer that refuses an empty plan, and persist that same
// zombie by the back door.
//
// This set excludes `done` and `failed` too, so moveLive() usually returns
// before patch() sees them. patch() is still the one place the settled rule
// lives, and the backstop if this set ever grows.
const HAS_ORDERS = new Set(['planned', 'running', 'stalled']);

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
    // A REVIEW HOLD (plan 3, Task 0). While true, lib/scheduler leaves this
    // goal's queued orders alone, so a human can read the PM's plan before
    // anything executes; release() is the only thing that clears it. A human
    // can still dispatch one order by id while it is held - that is the
    // approval gate, and the hold is what makes it a real one with the loop
    // running. STRICT: only `true` holds. A truthy non-boolean is refused by
    // the route and never read as a request here.
    held: src.hold === true,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  store.writeJson(root, rel(goal.id), goal);
  return goal;
}

// Records written before holds existed carry no `held` key: not held. Strict
// for the same reason create() is - a hand-edited "true" is not a hold.
function isHeld(g) {
  return !!g && g.held === true;
}

// Clear the hold. Through patch(), so a SETTLED goal is handed back unchanged:
// there is nothing left to release it into, and a settled record is never
// rewritten. A goal that is not held is handed back unchanged too - the route
// turns both into a 409, and this stays a plain mover like the others.
function release(root, id) {
  const g = get(root, id);
  if (!g) return null;
  if (!isHeld(g)) return g;
  return patch(root, id, { held: false });
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
  // An empty plan is not a plan - withinBudget() says so one function away, and
  // this is the function that writes the transition. `planned` with no orders
  // is a goal nothing can finish and nothing can honestly run: it is not
  // SETTLED, reconcile() does not sweep it, and markDone() on it would settle a
  // goal that did nothing on a vacuous "every order settled". A caller with no
  // orders wants failPlanning().
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    throw new Error('orderIds is required: a plan with no orders is not a plan');
  }
  return patch(root, id, {
    // NOT `running`. A plan on disk is not work in progress - lib/plan does not
    // dispatch, deliberately, because a human approves each order through
    // POST /api/orders/:id/dispatch, so every order here is `queued` and no
    // agent exists yet.
    status: 'planned',
    // Copied, not aliased: the caller's array must not keep mutating the
    // record it already handed over.
    orderIds: orderIds.slice(),
    pmAgent: pmAgent || null,
    rawPlan: typeof rawPlan === 'string' ? rawPlan : null,
  });
}

// patch() with the `planning` end guarded as well. Returns the record unchanged
// rather than throwing, exactly as patch() does for a settled one: the callers
// are sweeps that walk many goals, and a goal that settled since the sweep
// started is a race, not a caller fault. The record it hands back is the truth.
function moveLive(root, id, changes) {
  const g = get(root, id);
  if (!g) return null;
  if (!HAS_ORDERS.has(g.status)) return g;
  return patch(root, id, changes);
}

// An order of this goal started. Recorded, not verified - see Known limits.
function markRunning(root, id) {
  return moveLive(root, id, { status: 'running' });
}

// The last in-flight order settled and others are still queued. The goal goes
// BACK to `planned`: work is outstanding, but nothing is executing it.
function markPlanned(root, id) {
  return moveLive(root, id, { status: 'planned' });
}

// Every order this goal names has settled - as judged by the caller, which is
// the only party that can see them. `done` is SETTLED, so this is the record's
// last word and finishedAt is what makes it a moment rather than a state.
function markDone(root, id) {
  return moveLive(root, id, {
    status: 'done',
    finishedAt: new Date().toISOString(),
  });
}

// Nothing outstanding, and a human is needed. Recorded, not verified - the
// caller (lib/scheduler, through lib/chains.goalOutcome) is the only party
// that can see the orders.
function markStalled(root, id) {
  return moveLive(root, id, { status: 'stalled' });
}

// An order chain ended rejected with no retry coming. NOT failPlanning: that
// one leaves `planning`, this one leaves a state that has orders, and moveLive
// refuses `planning` so the two doors cannot be confused. Same nullish guard,
// for the same reason - `failed` is settled, so a record saying "undefined" is
// stuck saying it.
function markFailed(root, id, error) {
  const message = error === undefined || error === null ? 'unspecified failure' : String(error);
  return moveLive(root, id, {
    status: 'failed',
    error: message,
    finishedAt: new Date().toISOString(),
  });
}

// A retry is a new order of the same goal, and orderIds is AUTHORITATIVE
// (lib/plan says so: "A reader listing a goal's orders must read orderIds").
// So the goal must name it, or the per-goal budget cannot count it and the
// chain cannot see it.
//
// Live goals only, through the same guard as the movers: a settled goal takes
// no new work. Returns the record unchanged for a settled or planning goal -
// the caller checks `orderIds.includes(orderId)` to know whether it landed.
// Throws on a malformed orderIds rather than replacing it: the existing list
// is the spend record, and overwriting it is how a budget forgets.
//
// The spread rather than a push is NOT pinned by a test and cannot be: get()
// reads a fresh object from disk on every call, so no earlier reader shares
// this array and a push would be an equivalent mutant. It stays because
// immutability is this repository's rule, not because a test needs it.
function addOrder(root, id, orderId) {
  if (typeof orderId !== 'string' || !orderId.trim()) {
    throw new Error(`orderId is required, got ${JSON.stringify(orderId)}`);
  }
  const g = get(root, id);
  if (!g) return null;
  if (!HAS_ORDERS.has(g.status)) return g;
  if (!Array.isArray(g.orderIds)) throw new Error(`goal ${id} has a malformed orderIds`);
  if (g.orderIds.includes(orderId)) return g;
  return patch(root, id, { orderIds: [...g.orderIds, orderId] });
}

// The PM could not produce a usable plan. Never retried: that is a prompt
// problem a human needs to see, and a silent retry hides it.
function failPlanning(root, id, error, rawPlan) {
  // Same guard lib/orders.markFailed carries, for the same reason: this error
  // is the record's only diagnosis, so a nullish argument must not land on disk
  // as an error literally named "undefined". The caller writing
  // `catch (e) { failPlanning(root, id, e.message, raw) }` hands over undefined
  // for a thrown string or a non-Error rejection - and 'failed' is SETTLED, so
  // patch() refuses every later write and the record is stuck saying nothing.
  const message = error === undefined || error === null
    ? 'unspecified planning failure'
    : String(error);
  return patch(root, id, {
    status: 'failed',
    error: message,
    rawPlan: typeof rawPlan === 'string' ? rawPlan : null,
    finishedAt: new Date().toISOString(),
  });
}

// Spec 8a: a plan over the cap fails the goal whole. Truncating to the first N
// produces a half-executed goal that looks complete, and nothing signals the
// missing orders.
//
// The one answer this must never give by accident is "unlimited", so it says so
// in exactly two cases and refuses in every other: no budget at all, and a
// budget carrying no maxOrdersPerGoal. A cap that IS present is honoured
// literally - 0 and negatives refuse everything, and a present-but-unusable cap
// ('12', NaN) is a mis-typed cap that refuses too. Reading either as unlimited
// switches the ceiling off silently, which is the failure lib/projects'
// BUDGET_MAX comment names as well: "1e15 disables the guard exactly as
// effectively as 0 does". Refusing loudly is recoverable; a budget that is
// quietly not a budget is not.
function withinBudget(count, budget) {
  if (!Number.isInteger(count) || count < 1) return false; // an empty plan is not a plan
  if (budget === undefined || budget === null) return true; // no budget configured
  // A budget is the object that HOLDS the cap, not the cap itself. Passing the
  // number straight in - the natural slip when the parameter is named `budget`
  // and the caller is holding project.budget.maxOrdersPerGoal - reads as an
  // absent cap on any object accessor, so it would pass any plan of any size.
  // Fail closed on the shape exactly as the count above fails closed.
  if (typeof budget !== 'object' || Array.isArray(budget)) return false;
  const cap = budget.maxOrdersPerGoal;
  if (cap === undefined || cap === null) return true; // budget carries no goal cap
  if (!Number.isFinite(cap)) return false;
  return count <= cap;
}

// On boot, a goal still `planning` lost the PM that was decomposing it, and a
// goal still `running` lost the agents its claim rested on.
//
// These writes bypass patch(), deliberately: patch() refuses to move a settled
// goal and 'failed' IS settled, so routing the sweep through it would make
// reconcile a no-op the moment it mattered. Every goal it touches is by
// definition still live, so the rule patch() enforces is not in question here.
function reconcile(root) {
  let n = 0;
  for (const g of list(root)) {
    // `running` claims an order of this goal is in flight, and after a restart
    // nothing can honour that claim. NOT because the agents are dead: they are
    // spawned detached (lib/runner), so one CAN outlive a SIGKILL or the
    // double-^C exit and still be writing to a tree - lib/dispatch says exactly
    // that. What died with the process is everything that could observe one:
    // the timeout that bounds it, the handler that records its outcome, the
    // in-flight map that could reap it. So `running` is UNRECORDABLE here,
    // which is weaker than "nothing is executing" and is enough - it is the
    // same assumption lib/orders.reconcile force-settles those very orders to
    // `interrupted` on. This does not depend on that having run first, and does
    // not read an order.
    //
    // Demoted rather than failed: the plan and its orders are still on disk,
    // and some of them may never have been dispatched at all.
    //
    // This one branch is also the whole migration for plan 2b, which wrote
    // `running` at plan-persist time for what is now `planned`. A 2b record
    // needs exactly the correction a crashed 2c record needs, so nothing has to
    // tell them apart and no flag has to be carried to say which is which.
    // It happens once per store: after this boot, `running` on disk means what
    // it says. NOT counted - see the Known limits note on the return value.
    if (g.status === 'running') {
      store.writeJson(root, rel(g.id), { ...g, status: 'planned' });
      // PROVABLY DEAD, and a mutation sweep says so: deleting it changes
      // nothing observable, because `g` is the in-memory record from list() and
      // still reads `running`, so the `!== 'planning'` test below continues
      // anyway. It stays so the two branches read as alternatives rather than
      // one falling through the other, which is what a later reorder of these
      // two tests would silently break.
      continue;
    }
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

module.exports = {
  create, get, list, planned, markRunning, markPlanned, markDone, isHeld, release,
  markStalled, markFailed, addOrder,
  failPlanning, withinBudget, reconcile, newId, SETTLED,
};
