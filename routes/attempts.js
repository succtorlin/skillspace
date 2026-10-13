'use strict';
const orders = require('../lib/orders');
const goals = require('../lib/goals');
const projects = require('../lib/projects');
const attempts = require('../lib/attempts');
const verdict = require('../lib/verdict');
const requireDeps = require('./deps');
const { RUN_ROUTE_REQUIRED, errorMessage, resolveAgent } = require('./common');

// The two doors a human uses after a verdict. Same factory contract as the
// sibling route modules; RUN_ROUTE_REQUIRED because one of them spawns a
// credentialed agent and the other creates work the loop will run.
//
// BOTH ANSWER FROM THE AUTHORITY, NOT FROM A PRE-CHECK. attempts.supersede()
// and verdict.judge() each make their admission decision synchronously and
// return it, so there is no gap between "the route checked" and "the claim was
// taken" for a second request to fall into - the gap the dispatch route needed
// isClaimed() to narrow, and could only narrow. The concurrent double-POST
// tests exercise both from the wire; they are evidence, not the pin - a short
// yield inside supersede() slips past them (measured), so its synchronous
// contract is pinned directly in test/attempts.test.js, and judge()'s by
// test/verdict.test.js reading the claim the moment judge() returns.
//
// Known limits:
// - plainIdFrom RESPONDS AND RETURNS NULL; the next line must be a return.
//   Shared with every sibling.
// - verdict/retry ADMITS a never-attempted verdict as well as an errored one.
//   With SKILLSPACE_SCHEDULER=0 nothing else would ever judge an order, and a
//   second door named "judge" for the same function is a second thing to keep
//   in step. The name says retry because that is what a board will offer it
//   for.
// - retry DOES NOT DISPATCH. The new attempt is `queued`; the loop runs it, or
//   - with the loop off - a human dispatches it by id, the approval gate 2b
//   put there.

// Refusal kinds from lib/attempts and lib/verdict, mapped once.
const STATUS = { missing: 404, conflict: 409, final: 409, limit: 429, capacity: 429 };

module.exports = (deps) => {
  requireDeps('routes/attempts', deps, RUN_ROUTE_REQUIRED);
  const {
    root, sendJson, readBody, OVERSIZE, ABORTED,
    plainIdFrom, isTopLevelNavigation, denyNavigation, AGENTS, maxConcurrentRuns, childEnv,
  } = deps;

  return async ({ req, res, p }) => {
    // Spec 7: "creates a NEW order with supersedes set; the original is never
    // re-run or overwritten". It does NOT dispatch: the loop runs queued work,
    // and with the loop off a human dispatches it - the approval gate stays
    // where 2b put it.
    const retryMatch = p.match(/^\/api\/orders\/([^/]+)\/retry$/);
    if (retryMatch && req.method === 'POST') {
      if (isTopLevelNavigation(req)) {
        denyNavigation(res, '/api/orders/:id/retry');
        return true;
      }
      const id = plainIdFrom(res, retryMatch[1], 'order');
      if (id === null) return true;
      let r;
      try {
        r = attempts.supersede(root, { orderId: id, origin: 'human' });
      } catch (e) {
        sendJson(res, 500, { error: errorMessage(e) });
        return true;
      }
      if (r.refused) {
        sendJson(res, STATUS[r.kind] || 409, {
          error: r.refused,
          ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
        });
        return true;
      }
      // The attempt EXISTS by now, so a chain that cannot be derived is
      // `chain: null`, not a 500 that would tell the caller nothing happened.
      let chain = null;
      try {
        chain = attempts.chainFor(root, r.order);
      } catch (e) {
        console.warn('[attempts] could not derive the chain of %s: %s', r.order.id, errorMessage(e));
      }
      sendJson(res, 200, { order: r.order, chain });
      return true;
    }

    const verdictMatch = p.match(/^\/api\/orders\/([^/]+)\/verdict\/retry$/);
    if (verdictMatch && req.method === 'POST') {
      if (isTopLevelNavigation(req)) {
        denyNavigation(res, '/api/orders/:id/verdict/retry');
        return true;
      }
      const id = plainIdFrom(res, verdictMatch[1], 'order');
      if (id === null) return true;
      // Optional { agent }: judge with a different installed agent than the
      // goal's PM - the way out when the PM agent has been uninstalled.
      const body = await readBody(req);
      if (body[ABORTED]) return true;
      if (body[OVERSIZE]) {
        sendJson(res, 413, { error: 'request body too large' });
        return true;
      }
      // Every read below happens AFTER the await above and BEFORE judge(),
      // with no await between - so judge()'s synchronous admission sees the
      // same world these did, and a concurrent second request is refused by
      // judge() itself ('already being judged').
      const order = orders.get(root, id);
      if (!order) {
        sendJson(res, 404, { error: 'no such order' });
        return true;
      }
      if (!order.goalId) {
        sendJson(res, 409, { error: 'an order outside a goal has no PM to judge it' });
        return true;
      }
      const goal = goals.get(root, order.goalId);
      const project = projects.get(root, order.projectId);
      const named = body.agent !== undefined && body.agent !== null && body.agent !== '';
      const picked = resolveAgent(AGENTS, named ? body : { agent: goal ? goal.pmAgent : null });
      if (picked.error) {
        // A name in THIS request is the caller's fault; a stored pmAgent that
        // is no longer installed is the state's.
        sendJson(res, named ? 400 : 409, { error: picked.error });
        return true;
      }
      let r;
      try {
        r = verdict.judge(root, {
          order, goal, project, agent: picked.agent, childEnv, allowFrom: [null, 'error'],
        });
      } catch (e) {
        sendJson(res, 500, { error: errorMessage(e) });
        return true;
      }
      if (r.refused) {
        const status = STATUS[r.kind] || 409;
        sendJson(res, status, {
          error: r.kind === 'capacity' ? `too many agents running (${maxConcurrentRuns})` : r.refused,
        });
        return true;
      }
      r.done.catch((e) => {
        console.error('[server] judging %s failed:', id, errorMessage(e));
        verdict.recordCrash(root, id, e);
      });
      // `judging` is what was ACCEPTED. Follow it with GET.
      sendJson(res, 200, { order: r.order });
      return true;
    }

    return false;
  };
};
