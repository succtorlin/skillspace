'use strict';
const projects = require('../lib/projects');
const requireDeps = require('./deps');

// Must stay in step with the destructure below. Deliberately shorter than the
// orders route's: the server hands both modules the same object, and taking
// keys this one does not use would hide which capabilities it really has.
const REQUIRED = ['root', 'sendJson', 'readBody', 'OVERSIZE', 'ABORTED', 'plainIdFrom'];

// The project routes, lifted out of server.js unchanged. A factory taking the
// server's dependencies once and returning a handler that answers true when it
// answered and false when the path was not ours, so route() can try each
// module in turn without knowing what either owns.
//
// Everything the handlers need arrives through the factory rather than through
// a require: SKILLSPACE_HOME, the response helpers and the request guards all
// belong to the server, and reaching back into it from here would make the
// dependency circular. Only what this module actually uses is named - the
// server hands both modules the same deps, and taking keys it does not need
// would hide which capabilities this one really has.
module.exports = (deps) => {
  requireDeps('routes/projects', deps, REQUIRED);
  const { root, sendJson, readBody, OVERSIZE, ABORTED, plainIdFrom } = deps;

  return async ({ req, res, p }) => {
    if (p === '/api/projects' && req.method === 'GET') {
      sendJson(res, 200, { projects: projects.list(root) });
      return true;
    }

    if (p === '/api/projects' && req.method === 'POST') {
      const body = await readBody(req);
      if (body[ABORTED]) return true; // no client left to answer, and nothing to store
      if (body[OVERSIZE]) {
        sendJson(res, 413, { error: 'request body too large' });
        return true;
      }
      try {
        sendJson(res, 200, { project: projects.create(root, body) });
      } catch (e) {
        // create() emits exactly three caller-fault shapes; anything else (EACCES
        // on an unwritable store, for one) is ours, and reporting it as 400 told
        // the user their input was bad when the disk was.
        const msg = String((e && e.message) || e);
        const clientFault = /^path (does not exist|is not a directory|is protected)/.test(msg);
        sendJson(res, clientFault ? 400 : 500, { error: msg });
      }
      return true;
    }

    // Single trailing segment only: startsWith would also swallow nested routes
    // like /api/projects/:id/goals/:goalId, answering "invalid project id" for a
    // path this handler was never meant to own.
    const delMatch = req.method === 'DELETE' && p.match(/^\/api\/projects\/([^/]+)$/);
    if (delMatch) {
      const id = plainIdFrom(res, delMatch[1], 'project');
      if (id === null) return true; // already answered 400
      if (!projects.remove(root, id)) {
        // remove() reports whether anything matched, so an unknown id 404s
        // instead of reporting a success that never happened.
        sendJson(res, 404, { error: 'no such project' });
        return true;
      }
      // The record is gone; the working directory is deliberately untouched.
      sendJson(res, 200, { ok: true, filesKept: true });
      return true;
    }

    return false;
  };
};
