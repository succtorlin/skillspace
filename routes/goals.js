'use strict';
const projects = require('../lib/projects');
const goals = require('../lib/goals');
const orders = require('../lib/orders');
const planner = require('../lib/plan');
const dispatch = require('../lib/dispatch');
const requireDeps = require('./deps');

// Must stay in step with the destructure below; same second-place-to-edit note
// routes/orders.js carries.
const REQUIRED = [
  'root', 'sendJson', 'readBody', 'OVERSIZE', 'ABORTED',
  'plainIdFrom', 'isTopLevelNavigation', 'denyNavigation',
  'AGENTS', 'maxConcurrentRuns', 'childEnv',
];

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
// - THE CEILING GATE IS THE ONLY BOUND ON PM CONCURRENCY. For an order the
//   route's 429 is a courtesy - dispatch.runOrder enforces the same predicate
//   itself, so a caller that skips the route is still bounded. lib/plan.decompose
//   does NOT: it checks the agent, the environment policy, the budget and the
//   project claim, but never atCapacity. So this gate is load-bearing, and a
//   held-down button on this route is exactly what it stops. Pushing the
//   predicate into decompose (as runOrder has it) is the real fix and belongs
//   with the scheduler in plan 2c, which is the first caller that will reach
//   decompose without coming through here.
//
// Known limits, recorded rather than fixed - all three inherited verbatim from
// routes/orders.js, and all three fixed in one place when they are fixed at all.
// Diverging here alone would be worse than the flaw: two adjacent routes that
// disagree about what a request means is a harder bug than one they share.
// - `?project=` WITH AN EMPTY VALUE lists every goal rather than none.
// - plainIdFrom RESPONDS AND RETURNS NULL, so the caller's next line must be a
//   return.
// - A NON-STRING `agent` IS READ AS ABSENT AND SILENTLY DEFAULTED. `{"agent":
//   5}` gets AGENTS[0] and a 200, where `{"agent":"5"}` gets a 400. That is the
//   same silent substitution the unrecognised-id refusal below exists to
//   prevent, one type away: the caller named something, and something else ran.
//   Found by mutation - `body.agent || ''` refuses the non-string case and no
//   test could tell the two apart. The console only ever sends a string, so it
//   is a malformed-client hole rather than a reachable one.
module.exports = (deps) => {
  requireDeps('routes/goals', deps, REQUIRED);
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
      // behind. An absent agent still defaults to the first installed one, but a
      // named-and-unrecognised one is refused rather than silently substituted:
      // the goal record persists `pmAgent`, so a substitution would make the
      // store assert the caller asked for an agent they never named.
      // Caller-input faults are checked before the capacity bound below, so a
      // bad id is not masked by a transient 429 the client would retry.
      const requested = typeof body.agent === 'string' ? body.agent : '';
      const agent = requested ? AGENTS.find((a) => a.id === requested) : AGENTS[0];
      if (!agent) {
        sendJson(res, 400, {
          error: requested
            ? `未知的 agent：${requested}（可用：${AGENTS.map((a) => a.id).join(', ') || '无'}）`
            : '没有检测到可用的 agent',
        });
        return true;
      }

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
        // on an unwritable store, for one) is ours.
        //
        // Anchored at the START, exactly as routes/orders.js is and for the
        // reason recorded there: lib/goals throws "text is too long (100001 >
        // 100000)", so an alternation anchored at the END matches nothing and
        // every oversize input comes back 500 - SkillSpace claiming it broke,
        // for an input the user only needs to shorten.
        const msg = String((e && e.message) || e);
        const clientFault = /^\w+ (is required|is too long)/.test(msg);
        sendJson(res, clientFault ? 400 : 500, { error: msg });
        return true;
      }

      // Planning WITHOUT awaiting: decompose resolves only when the PM exits,
      // which is up to the project's orderTimeoutMs - 15 minutes by default -
      // so awaiting it would hold the connection open for the length of the
      // run. The caller gets the `planning` record and follows it with GET.
      planner
        .decompose(root, { goal, project, agent, childEnv })
        .catch((e) => {
          // decompose records its own failures on the goal, so a REJECTION means
          // a bug in lib/plan rather than a PM that could not plan - the one
          // outcome with no durable trace unless this writes one. Without it the
          // goal sits at `planning` until the next boot's reconcile, and the
          // reason exists only on a console nobody is reading.
          console.error('[server] goal %s failed to plan:', goal.id, e.message);
          try { goals.failPlanning(root, goal.id, `plan: ${e.message}`, null); } catch (_) {}
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
      const orderIds = Array.isArray(goal.orderIds) ? goal.orderIds : [];
      sendJson(res, 200, {
        goal,
        orders: orderIds.map((oid) => orders.get(root, oid)).filter(Boolean),
      });
      return true;
    }

    return false;
  };
};
