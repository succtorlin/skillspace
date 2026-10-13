'use strict';
const projects = require('../lib/projects');
const goals = require('../lib/goals');
const orders = require('../lib/orders');
const planner = require('../lib/plan');
const dispatch = require('../lib/dispatch');
const attempts = require('../lib/attempts');
const requireDeps = require('./deps');
const {
  RUN_ROUTE_REQUIRED, isPlainId, errorMessage, clientFault, resolveAgent,
} = require('./common');

// The goal routes. Same contract as routes/projects.js and routes/orders.js: a
// factory taking the server's dependencies once and returning a handler that
// answers true when it answered and false when the path was not ours.
// Everything from the server arrives through the factory rather than through a
// require back into it - reaching back into server.js would make the dependency
// circular.
//
// This is the fourth route-shaped module, and the protections below are
// inherited from routes/orders.js deliberately rather than re-derived, because
// twice now a new module has had to learn one of them the hard way: the
// navigation guard, the ceiling gate before any record exists, the oversize and
// aborted-body paths, plainIdFrom validation, and the 400-vs-500 split anchored
// at the START of the message.
//
// Differences from routes/orders.js, each on purpose:
//
// - NO PROJECT-BUSY PRE-CHECK. The orders route asks dispatch.projectBusy first
//   so a refusal never leaves a `queued` order nothing will dispatch. A goal has
//   no such state: lib/plan.decompose refuses a busy unisolated project by
//   FAILING the goal, with the reason on the record, and lib/plan says why -
//   "an order refused stays queued for a scheduler to retry, but nothing
//   retries a goal". A 200 followed immediately by a failed goal carrying
//   "project busy" is a readable outcome; a second copy of the check here would
//   be a second thing to keep in step with decompose's, which still has to
//   handle the race regardless.
// - THE CEILING GATE IS THE ONLY BOUND ON PM CONCURRENCY, and it is only a
//   bound because lib/plan now claims its slot SYNCHRONOUSLY. For an order the
//   route's 429 is a courtesy - dispatch.runOrder re-checks the predicate
//   itself - but decompose does not re-check, so this gate is load-bearing.
//   It did not hold when it was written: decompose registered in its in-flight
//   map only after `await worktrees.prepare`, so a concurrent BURST of eight
//   POSTs on git projects all passed atCapacity() while the count was still 0
//   and ran eight PMs at a ceiling of one. Measured, fixed in lib/plan.js, and
//   pinned by 'a burst of goals on git projects cannot outrun the ceiling'.
//   Anyone re-pricing the deferral below should re-read that: this route's gate
//   is exactly as strong as that synchronous claim.
//
//   Pushing the predicate into decompose (as runOrder has it) remains the real
//   fix, and belongs with the scheduler in plan 2c - the first caller that will
//   reach decompose without coming through here.
//
// Known limits, recorded rather than fixed - both shared with routes/orders.js,
// and the shared half of both routes now genuinely has ONE place to be fixed in
// (routes/common.js) rather than two files that agreed by hand:
// - `?project=` WITH AN EMPTY VALUE lists every goal rather than none.
// - plainIdFrom RESPONDS AND RETURNS NULL, so the caller's next line must be a
//   return.
//
// And one that is this route's alone:
// - A PM RUN IS NOT COUNTED against the project's maxOrdersPerDay. Planning is
//   refused once the day's order budget is spent (lib/plan.decompose), which
//   bounds the common case, but a PM that never produces a plan leaves the
//   count untouched and can be re-posted indefinitely. lib/plan.js records why:
//   the cap is derived from order records, and a failed PM leaves none.
module.exports = (deps) => {
  requireDeps('routes/goals', deps, RUN_ROUTE_REQUIRED);
  const {
    root, sendJson, readBody, OVERSIZE, ABORTED,
    plainIdFrom, isTopLevelNavigation, denyNavigation, AGENTS, maxConcurrentRuns,
    childEnv,
  } = deps;

  return async ({ req, res, u, p }) => {
    if (p === '/api/goals' && req.method === 'GET') {
      const projectId = u.searchParams.get('project') || null;
      sendJson(res, 200, { goals: goals.list(root, projectId ? { projectId } : {}) });
      return true;
    }

    if (p === '/api/goals' && req.method === 'POST') {
      // Planning spawns a credentialed agent, so it carries the same guard as
      // creating an order: a link clicked in Slack or Mail must not start work.
      if (isTopLevelNavigation(req)) {
        denyNavigation(res, '/api/goals');
        return true;
      }

      const body = await readBody(req);
      if (body[ABORTED]) return true; // no client left to answer, and nothing to store
      if (body[OVERSIZE]) {
        sendJson(res, 413, { error: 'request body too large' });
        return true;
      }

      const project = projects.get(root, String(body.projectId || ''));
      if (!project) {
        sendJson(res, 404, { error: 'no such project' });
        return true;
      }

      // Resolved BEFORE the record is created, so a refusal leaves nothing
      // behind. The rule itself lives in routes/common.js, shared with the
      // orders route: the goal record persists `pmAgent`, so a silent
      // substitution would make the store assert the caller asked for an agent
      // they never named. Caller-input faults are checked before the capacity
      // bound below, so a bad id is not masked by a transient 429 the client
      // would sensibly retry - forever, since retrying never makes it valid.
      const picked = resolveAgent(AGENTS, body);
      if (picked.error) {
        sendJson(res, 400, { error: picked.error });
        return true;
      }
      const agent = picked.agent;

      // Before create(), for the same reason the orders route puts it there: a
      // refused request must not leave a record behind. Unlike an order's, a
      // goal admitted past the ceiling would not merely sit `planning` until
      // the next reboot - decompose does not re-check capacity, so it would
      // actually spawn a PM over the bound. See the note above.
      if (dispatch.atCapacity()) {
        sendJson(res, 429, { error: `too many agents running (${maxConcurrentRuns})` });
        return true;
      }

      let goal;
      try {
        goal = goals.create(root, { projectId: project.id, text: body.text });
      } catch (e) {
        // goals.create emits its own caller-fault shapes; anything else (EACCES
        // on an unwritable store, for one) is ours. The predicate is shared
        // with the orders route - see routes/common.js for why it is anchored
        // where it is.
        sendJson(res, clientFault(e) ? 400 : 500, { error: errorMessage(e) });
        return true;
      }

      // Planning WITHOUT awaiting: decompose resolves only when the PM exits,
      // which is up to the project's orderTimeoutMs - 15 minutes by default -
      // so awaiting it would hold the connection open for the length of the
      // run. The caller gets the `planning` record and follows it with GET.
      planner
        .decompose(root, { goal, project, agent, childEnv })
        .catch((e) => {
          // decompose records its own failures ON the goal, so a REJECTION means
          // a bug in lib/plan rather than a PM that could not plan.
          //
          // What this reliably provides is the CONSOLE LINE, and the comment
          // that used to be here claimed more: it said the failPlanning below
          // stops the goal sitting at `planning` until the next boot. It often
          // cannot. The reachable producer of a rejection is a goals/ directory
          // that stopped being writable mid-run, and failPlanning writes that
          // same directory - so in the one scenario anyone has reproduced, the
          // durable half is exactly the half that fails. It is kept as
          // best-effort for a rejection with some other cause, and the plan's
          // own rollback (not this catch, which has no order ids) is what stops
          // the orders being stranded.
          //
          // errorMessage(), not e.message: a thrown string or a non-Error
          // rejection has no .message, and reading one off a nullish rejection
          // throws INSIDE the catch that exists to prevent an unhandled one.
          const why = errorMessage(e);
          console.error('[server] goal %s failed to plan:', goal.id, why);
          try { goals.failPlanning(root, goal.id, `plan: ${why}`, null); } catch (_) {}
        });

      // `planning` is what was ACCEPTED, not necessarily what is current:
      // decompose runs up to its first await in this same tick. Follow it with
      // GET.
      sendJson(res, 200, { goal });
      return true;
    }

    const goalMatch = p.match(/^\/api\/goals\/([^/]+)$/);
    if (goalMatch && req.method === 'GET') {
      // 'goal', not 'goal id': plainIdFrom builds "invalid ${label} id" itself.
      const id = plainIdFrom(res, goalMatch[1], 'goal');
      if (id === null) return true; // already answered 400
      const goal = goals.get(root, id);
      if (!goal) {
        sendJson(res, 404, { error: 'no such goal' });
        return true;
      }
      // The orders come with it: a reader always wants both, and a second round
      // trip would race the goal moving on.
      //
      // orderIds is read defensively because lib/goals' own usable() check does
      // not require it - a record that parses with the wrong shape reaches
      // list() and get() alike. Such a goal reads as one with no orders rather
      // than as a 500 from .map on undefined, which matches how lib/goals
      // already treats a malformed record: dropped from view, not fatal.
      //
      // An id in orderIds naming an order that no longer exists is filtered
      // out rather than reported as null - lib/plan writes the orders before
      // the goal names them, so a gap means the store lost one, and a reader
      // wants the orders that exist.
      //
      // isPlainId screens the ELEMENTS, which the Array.isArray check does not:
      // lib/goals states that orderIds are "stored, not validated", and
      // store.abs() THROWS on an id like '../../etc/hosts' rather than reading
      // it. Unscreened, that throw reached the server's catch-all and the goal
      // became permanently unreadable through this route with a bare 500 -
      // "one bad file unreadable rather than merely empty", which is the exact
      // outcome the paragraph above says must not happen. No data was ever
      // exposed; store.abs refuses before it reads.
      const orderIds = (Array.isArray(goal.orderIds) ? goal.orderIds : []).filter(isPlainId);
      const found = orderIds.map((oid) => orders.get(root, oid)).filter(Boolean);
      // Chains beside the records, never merged in - see routes/orders.js.
      sendJson(res, 200, { goal, orders: found, chains: attempts.chainMap(root, found) });
      return true;
    }

    return false;
  };
};
