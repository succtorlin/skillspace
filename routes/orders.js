'use strict';
const projects = require('../lib/projects');
const orders = require('../lib/orders');
const dispatch = require('../lib/dispatch');

// The order routes. Same contract as routes/projects.js: a factory taking the
// server's dependencies once and returning a handler that answers true when it
// answered and false when the path was not ours. Everything from the server
// arrives through the factory rather than through a require back into it -
// reaching back into server.js would make the dependency circular.
//
// Constants bind at construction, so a missing capability is a wiring-time
// fault rather than a TypeError on the first request that happens to need it.
//
// Known limits, all recorded rather than fixed - they belong at the START of
// plan 2b, so the goals and board modules are written against the new shape
// instead of retrofitted onto this one:
//
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
//   orders keep a projectId that no longer resolves.

// The GLOBAL ceiling on concurrent agents is agentsRunning() in server.js -
// one count over both pools, which /api/run gates on too. maxOrdersPerDay is a
// daily cap, not a simultaneous one; without this bound a loop - or a
// held-down button - starts an unbounded number of credentialed agents.
//
// Per-project limiting is no longer entirely absent: dispatch serialises
// UNISOLATED (dir) projects on its own, refusing a second concurrent order
// with `refused: 'project busy'`, because two agents in one plain directory
// corrupt each other's edits. What is still missing is the graded
// project.concurrency limit for GIT projects, which get a worktree each and so
// need a throughput policy rather than a correctness guard - that belongs to
// the scheduler.

module.exports = (deps) => {
  const {
    root, sendJson, readBody, OVERSIZE, ABORTED,
    plainIdFrom, isTopLevelNavigation, denyNavigation, AGENTS, maxConcurrentRuns,
    agentsRunning, childEnv,
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
      // could disagree mid-shutdown. agentsRunning() adds /api/run's own pool,
      // because a ceiling only this route can see is not a process ceiling:
      // gating on the orders count alone still let an order in while /api/run
      // held every slot.
      if (agentsRunning() >= maxConcurrentRuns) {
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
        // orders.create emits its own caller-fault shapes; anything else is ours.
        //
        // Anchored at the START, like routes/projects.js. lib/orders throws
        // "prompt is too long (100001 > 100000)", so a trailing anchor matched
        // the alternation and then failed - sending 500 for an input the user
        // must shorten. Mutation testing cannot catch that: deleting the dead
        // alternative is behaviourally identical to keeping it, which is why it
        // took a boundary test.
        //
        // Matching on prose is the real weakness here. The intended fix is for
        // lib/orders to tag its caller faults - e.code = 'EINVAL' - so this
        // becomes a field check rather than a regex over a message anyone might
        // reword. Deferred because lib/orders.js is closed; do it when that file
        // is next opened.
        const msg = String((e && e.message) || e);
        const clientFault = /^\w+ (is required|is too long)/.test(msg);
        sendJson(res, clientFault ? 400 : 500, { error: msg });
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
          console.error('[server] order %s failed to dispatch:', order.id, e.message);
          try { orders.markFailed(root, order.id, `dispatch: ${e.message}`); } catch (_) {}
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

    return false;
  };
};
