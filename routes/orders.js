'use strict';
const projects = require('../lib/projects');
const orders = require('../lib/orders');
const dispatch = require('../lib/dispatch');

// The order routes. Same contract as routes/projects.js: true when answered,
// false when the path was not ours, and everything from the server arrives in
// ctx rather than through a require back into it.

// Track in-flight order dispatches so the same bound that protects /api/run
// protects this route. project.concurrency is the scheduler's per-project
// limit and does not exist yet; maxOrdersPerDay is a daily cap, not a
// simultaneous one. Without this a loop - or a held-down button - starts an
// unbounded number of credentialed agents.
const RUNNING_ORDERS = new Set();

async function orderRoutes(ctx) {
  const {
    req, res, u, p, root, sendJson, readBody, OVERSIZE, ABORTED,
    plainIdFrom, isTopLevelNavigation, AGENTS, maxConcurrentRuns,
  } = ctx;

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
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden: /api/orders is not a navigable URL');
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

    // Also before create(): a refused request must not leave a queued order
    // that nothing will ever dispatch.
    if (RUNNING_ORDERS.size >= maxConcurrentRuns) {
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
      const msg = String((e && e.message) || e);
      const clientFault = /(is required|is too long)$/.test(msg);
      sendJson(res, clientFault ? 400 : 500, { error: msg });
      return true;
    }

    // Dispatch WITHOUT awaiting: runOrder resolves only when the agent exits,
    // which is up to the project's orderTimeoutMs - 15 minutes by default. The
    // caller gets the queued record now and follows progress via GET.
    RUNNING_ORDERS.add(order.id);
    dispatch
      .runOrder(root, { order, project, agent })
      .catch((e) => {
        // runOrder rejecting means a bug in dispatch, not a failed order - a
        // failed order is recorded on the order itself. This path leaves no
        // durable trace, so put one on the record too.
        console.error('[server] order %s failed to dispatch:', order.id, e.message);
        try { orders.markFailed(root, order.id, `dispatch: ${e.message}`); } catch (_) {}
      })
      .finally(() => RUNNING_ORDERS.delete(order.id));

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
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
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
}

module.exports = orderRoutes;
