'use strict';
const projects = require('../lib/projects');
const orders = require('../lib/orders');
const dispatch = require('../lib/dispatch');
const requireDeps = require('./deps');
const {
  RUN_ROUTE_REQUIRED, errorMessage, clientFault, resolveAgent,
} = require('./common');

// The order routes. Same contract as routes/projects.js: a factory taking the
// server's dependencies once and returning a handler that answers true when it
// answered and false when the path was not ours. Everything from the server
// arrives through the factory rather than through a require back into it -
// reaching back into server.js would make the dependency circular.
//
// Constants bind at construction, and REQUIRED is checked there, so a
// capability the server forgot to wire is a boot-time fault rather than a
// TypeError on the first request that happens to need it.
//
// Known limits, all recorded rather than fixed - they belong at the START of
// plan 2b, so the goals and board modules are written against the new shape
// instead of retrofitted onto this one:
//
// - A CAPACITY REFUSAL FROM dispatch LEAVES A QUEUED ORDER. This route asks
//   first so the refusal is a 429 before any record exists, but a caller that
//   skips this route and calls runOrder directly gets `refused: 'at capacity'`
//   on a record that stays `queued`, and nothing retries it - there is still no
//   scheduler. Whoever writes that caller owns the leftover until there is one.
// - THE REQUIRED LIST IS A SECOND PLACE TO EDIT. It must stay in step with the
//   destructure below; drift costs only the boot-time check for the new key,
//   never correctness, so an omission degrades to the old behaviour rather than
//   breaking. A Proxy that threw on any undefined read would remove the
//   duplication and was rejected: it would also forbid a genuinely optional
//   dependency, which the three modules coming next are likely to want.
//   NARROWED: the list itself now lives in routes/common.js as
//   RUN_ROUTE_REQUIRED, shared with routes/goals.js, so it is one place to edit
//   rather than one per agent-spawning route. It still has to match the
//   destructure.
// - `?project=` WITH AN EMPTY VALUE lists every order rather than none. No
//   consumer today, but the board in plan 3 builds exactly this query and a
//   cleared filter is the obvious way to produce it.
// - plainIdFrom RESPONDS AND RETURNS NULL, so every caller must remember to
//   return immediately. Fine at the three call sites it has; misuse-prone past
//   that.
// - SHUTDOWN EXIT CODES are cosmetic rather than correct: the 6s hatch exits 0
//   after giving up on an order that never settled, and a second signal of any
//   kind exits 130, which is the code for SIGINT specifically. Both are wrong
//   in a way only a script reading $? would notice, and nothing does.
// - DELETE /api/projects/:id SUCCEEDS WITH ORDERS IN FLIGHT. The project
//   record vanishes while agents are still running against its path, and the
//   orders keep a projectId that no longer resolves. POST /:id/dispatch answers
//   409 for one of those rather than 500ing, which is containment, not a fix.
// - A DOUBLE-DISPATCH INSIDE THE CLAIM WINDOW ANSWERS 200 TWICE. The status
//   check below refuses anything not `queued`, and runOrder marks the record
//   running only after `worktree add` - tens of milliseconds on a git project -
//   so two POSTs inside that window both read `queued` and both pass. The order
//   is NOT run twice: runOrder's own `already dispatched` refusal catches the
//   second, and this route logs it. But the second caller is told 200. Closing
//   it needs dispatch to export whether an id is claimed - inFlight is private,
//   and projectBusy cannot stand in for it because it is true for every git
//   order on the project and would serialise the isolated case the guard exists
//   not to touch. It belongs with whoever next opens lib/dispatch.js.

// The GLOBAL ceiling on concurrent agents is one predicate, set on dispatch at
// boot in server.js and spanning both pools - this route's orders and
// /api/run's SSE children. maxOrdersPerDay is a daily cap, not a simultaneous
// one; without this bound a loop - or a held-down button - starts an unbounded
// number of credentialed agents.
//
// Per-project limiting is no longer entirely absent: dispatch serialises
// UNISOLATED (dir) projects on its own, refusing a second concurrent order
// with `refused: 'project busy'`, because two agents in one plain directory
// corrupt each other's edits. What is still missing is the graded
// project.concurrency limit for GIT projects, which get a worktree each and so
// need a throughput policy rather than a correctness guard - that belongs to
// the scheduler.

module.exports = (deps) => {
  requireDeps('routes/orders', deps, RUN_ROUTE_REQUIRED);
  const {
    root, sendJson, readBody, OVERSIZE, ABORTED,
    plainIdFrom, isTopLevelNavigation, denyNavigation, AGENTS, maxConcurrentRuns,
    childEnv,
  } = deps;

  return async ({ req, res, u, p }) => {
    if (p === '/api/orders' && req.method === 'GET') {
      const projectId = u.searchParams.get('project') || null;
      sendJson(res, 200, { orders: orders.list(root, projectId ? { projectId } : {}) });
      return true;
    }

    if (p === '/api/orders' && req.method === 'POST') {
      // Creating an order spawns a credentialed agent, so it carries the same
      // navigation guard as /api/run: a link clicked in Slack or Mail must not
      // be able to start work.
      if (isTopLevelNavigation(req)) {
        denyNavigation(res, '/api/orders');
        return true;
      }
      const body = await readBody(req);
      if (body[ABORTED]) return true;
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
      // /api/run was changed the same way, and it matters more here because the
      // order record persists `agent` as though it were what the caller asked
      // for. Caller-input faults are checked before the capacity bound below, so
      // a bad id is not masked by a transient 429 the client would retry.
      //
      // The rule moved to routes/common.js, shared with the goals route, and
      // gained one case while it moved: a PRESENT BUT NON-STRING agent is now
      // refused rather than read as absent. {"agent": 5} used to get AGENTS[0]
      // and a 200 while {"agent":"5"} got a 400 - the same silent substitution
      // this refusal exists to prevent, one type away.
      const picked = resolveAgent(AGENTS, body);
      if (picked.error) {
        sendJson(res, 400, { error: picked.error });
        return true;
      }
      const agent = picked.agent;

      // An unisolated project runs one order at a time - two agents in one plain
      // directory corrupt each other's edits. dispatch enforces that regardless;
      // asking here too is what keeps a refusal from becoming a queued order
      // nothing will ever dispatch, since there is no scheduler to retry it. The
      // window between this check and dispatch's claim is harmless: dispatch
      // re-checks, and the worst case is the 409 arriving as a refusal instead.
      if (project.kind !== 'git' && dispatch.projectBusy(project.id)) {
        sendJson(res, 409, {
          error: '该项目已有任务在运行（未隔离的目录一次只能跑一个）',
        });
        return true;
      }

      // Also before create(): a refused request must not leave a queued order
      // that nothing will ever dispatch.
      //
      // One registry, and one ceiling. dispatch owns the orders' in-flight
      // state because it owns the claim and the release; a second Set here
      // tracked the same fact and released at a different moment, so the two
      // could disagree mid-shutdown.
      //
      // atCapacity() spans BOTH pools, because a ceiling only this route can
      // see is not a process ceiling: counting orders alone still let one in
      // while /api/run held every slot. runOrder enforces the same predicate,
      // so this check is not the guard - it is what turns the guard's refusal
      // into a 429 BEFORE a record exists, since nothing would ever retry a
      // queued order dispatch declined.
      if (dispatch.atCapacity()) {
        sendJson(res, 429, { error: `too many orders running (${maxConcurrentRuns})` });
        return true;
      }

      let order;
      try {
        order = orders.create(root, {
          projectId: project.id,
          prompt: body.prompt,
          title: body.title,
          acceptance: body.acceptance,
        });
      } catch (e) {
        // orders.create emits its own caller-fault shapes; anything else is
        // ours. The predicate, its anchoring and the e.code deferral all moved
        // to routes/common.js, shared with the goals route - the end-anchored
        // version of this regex is the proof that a hand-copied guard drifts.
        sendJson(res, clientFault(e) ? 400 : 500, { error: errorMessage(e) });
        return true;
      }

      // Dispatch WITHOUT awaiting: runOrder resolves only when the agent exits,
      // which is up to the project's orderTimeoutMs - 15 minutes by default. The
      // caller gets the queued record now and follows progress via GET.
      dispatch
        .runOrder(root, { order, project, agent, childEnv })
        .catch((e) => {
          // runOrder rejecting means a bug in dispatch, not a failed order - a
          // failed order is recorded on the order itself. This path leaves no
          // durable trace, so put one on the record too.
          //
          // Reachable from outside, and tested: orders.countToday runs in
          // runOrder's prologue before the try that catches everything else, so
          // an orders/ directory that is writable but not READABLE makes it
          // throw here while leaving markFailed able to record the outcome. See
          // "a dispatch that rejects is recorded on the order" in
          // test/orders-api.test.js. Without markFailed the order sits at queued
          // forever and the reason exists only on a console nobody is reading.
          //
          // errorMessage(), not e.message: a thrown string or a non-Error
          // rejection has no .message, and reading one off a nullish rejection
          // throws INSIDE the catch that exists to prevent an unhandled one.
          const why = errorMessage(e);
          console.error('[server] order %s failed to dispatch:', order.id, why);
          try { orders.markFailed(root, order.id, `dispatch: ${why}`); } catch (_) {}
        });

      // `queued` is what was ACCEPTED, not what is current: runOrder runs up to
      // its first await in this same tick, so the record may already be running
      // by the time the client parses this. Follow it with GET.
      sendJson(res, 200, { order });
      return true;
    }

    const orderMatch = p.match(/^\/api\/orders\/([^/]+)$/);
    if (orderMatch && req.method === 'GET') {
      const id = plainIdFrom(res, orderMatch[1], 'order');
      if (id === null) return true; // already answered 400
      const order = orders.get(root, id);
      if (!order) {
        sendJson(res, 404, { error: 'no such order' });
        return true;
      }
      sendJson(res, 200, { order });
      return true;
    }

    const cancelMatch = p.match(/^\/api\/orders\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      if (isTopLevelNavigation(req)) {
        denyNavigation(res, '/api/orders/:id/cancel');
        return true;
      }
      const id = plainIdFrom(res, cancelMatch[1], 'order');
      if (id === null) return true; // already answered 400

      const existing = orders.get(root, id);
      if (!existing) {
        sendJson(res, 404, { error: 'no such order' });
        return true;
      }
      if (existing.status !== 'queued' && existing.status !== 'running') {
        sendJson(res, 409, { error: `order is already ${existing.status}` });
        return true;
      }
      // dispatch.cancel only reaches a RUNNING order. A queued one, or one still
      // preparing its worktree, has no handle yet - and that is exactly the
      // window a user is most likely to click cancel.
      if (!dispatch.cancel(id)) orders.markCancelled(root, id);
      // Re-read rather than trusting a return: markCancelled goes through patch,
      // which hands back the UNCHANGED record for an order that settled between
      // the check above and here.
      //
      // No black-box test can kill this line, and that is expected: dispatch
      // cancel only SIGNALs, and runner.finish() settles asynchronously once the
      // log has flushed, so on the running path the re-read observes `running`
      // whether or not it re-reads. It is here for the settled-in-between race
      // the paragraph above names, which a test cannot schedule.
      sendJson(res, 200, { order: orders.get(root, id) });
      return true;
    }

    // The APPROVAL GATE. Until this existed the order surface was create-and-
    // dispatch plus cancel, so an order a PM planned could never be run: the
    // only way to execute one was to re-POST its prompt, which created a THIRD
    // order with goalId null and left both originals queued forever. The plan,
    // lib/plan.js's header and the spec-coverage table all claimed a human
    // could "dispatch them individually through POST /api/orders" - approval
    // could not be granted, because there was nothing to grant it with.
    const dispatchMatch = p.match(/^\/api\/orders\/([^/]+)\/dispatch$/);
    if (dispatchMatch && req.method === 'POST') {
      // Every guard the create-and-dispatch path carries, in the same order and
      // for the same reasons - this spawns exactly the same credentialed agent,
      // so a link clicked in Slack must not start work here either.
      if (isTopLevelNavigation(req)) {
        denyNavigation(res, '/api/orders/:id/dispatch');
        return true;
      }
      const id = plainIdFrom(res, dispatchMatch[1], 'order');
      if (id === null) return true; // already answered 400

      // A body is optional - the common case is an empty POST - but it is read
      // before anything else so an `agent` override behaves exactly as it does
      // on create, and so an oversize or abandoned body is answered the same
      // way rather than being a shape this route alone gets wrong.
      const body = await readBody(req);
      if (body[ABORTED]) return true; // no client left to answer, and nothing started
      if (body[OVERSIZE]) {
        sendJson(res, 413, { error: 'request body too large' });
        return true;
      }

      const existing = orders.get(root, id);
      if (!existing) {
        sendJson(res, 404, { error: 'no such order' });
        return true;
      }
      // QUEUED ONLY. Re-dispatching a running order would put two agents on one
      // record - the second overwrites the first's handle in dispatch's map, so
      // cancel() would then reach neither - and re-dispatching a settled one
      // would run work whose outcome is already recorded. The record comes back
      // with the refusal so the caller can see WHY rather than guess.
      if (existing.status !== 'queued') {
        sendJson(res, 409, {
          error: `order is already ${existing.status}`,
          order: existing,
        });
        return true;
      }

      // 409 rather than 404: the request named a real order, and it is the
      // stored state that cannot be acted on. DELETE /api/projects/:id succeeds
      // with orders still pointing at it (recorded above), so this is reachable
      // without any corruption.
      const project = projects.get(root, existing.projectId);
      if (!project) {
        sendJson(res, 409, { error: "the order's project no longer exists" });
        return true;
      }

      // Same rule, same shared implementation. An absent agent takes the
      // default; a named-and-unrecognised one is refused rather than
      // substituted, because runOrder writes the resolved id onto the record.
      // Caller faults before the capacity bound, so a bad id is not masked by a
      // 429 the client would retry forever.
      const picked = resolveAgent(AGENTS, body);
      if (picked.error) {
        sendJson(res, 400, { error: picked.error });
        return true;
      }

      if (project.kind !== 'git' && dispatch.projectBusy(project.id)) {
        sendJson(res, 409, {
          error: '该项目已有任务在运行（未隔离的目录一次只能跑一个）',
        });
        return true;
      }
      // runOrder enforces this itself, so the gate is not the guard - it is what
      // turns a refusal into a 429 the caller can act on. Unlike the create
      // path there is no record to avoid leaving behind; the order is already
      // queued and stays that way, which is the honest state for one that was
      // never started.
      if (dispatch.atCapacity()) {
        sendJson(res, 429, { error: `too many orders running (${maxConcurrentRuns})` });
        return true;
      }

      // WITHOUT awaiting, exactly as the create path: runOrder resolves only
      // when the agent exits, up to the project's orderTimeoutMs.
      dispatch
        .runOrder(root, { order: existing, project, agent: picked.agent, childEnv })
        .then((r) => {
          // runOrder REFUSES by resolving with { refused }, it does not throw.
          // The status check above catches every refusal a caller can observe
          // except one - see the known limit on double-dispatch - and this is
          // the only place that window leaves a trace.
          if (r && r.refused) {
            console.warn('[server] order %s was not dispatched: %s', id, r.refused);
          }
        })
        .catch((e) => {
          // A rejection is a bug in dispatch, not a failed order, and it is the
          // one outcome with no durable trace unless this writes one.
          const why = errorMessage(e);
          console.error('[server] order %s failed to dispatch:', id, why);
          try { orders.markFailed(root, id, `dispatch: ${why}`); } catch (_) {}
        });

      // `queued` is what was ACCEPTED. runOrder claims its slot synchronously
      // but only marks the record running after `worktree add`, so the record
      // read back here is still queued whether or not it re-reads. Follow it
      // with GET.
      sendJson(res, 200, { order: existing });
      return true;
    }

    return false;
  };
};
