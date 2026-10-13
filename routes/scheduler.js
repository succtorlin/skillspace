'use strict';
const scheduler = require('../lib/scheduler');
const requireDeps = require('./deps');

// Must stay in step with the destructure below. One key, and deliberately one:
// scheduler.stats() is O(1) and reads no records, so this route needs neither
// `root` nor any of the request guards the two agent-spawning routes carry.
// Taking keys it does not use would hide which capabilities it really has -
// routes/projects.js makes the same argument for its shorter list - and here it
// also means the module cannot reach the store even by accident.
const REQUIRED = ['sendJson'];

// The scheduler's status, for a browser that polls it.
//
// Same contract as the three sibling route modules: a factory taking the
// server's dependencies once and returning a handler that answers true when it
// answered and false when the path was not ours. requireDeps is called at
// CONSTRUCTION, not per request - routes/deps.js exists because two factories
// once carried a comment promising a boot-time fault they did not deliver, and
// a fourth module repeating the promise without the call would repeat the bug.
//
// WHAT IT EXPOSES, and why it is stats() verbatim rather than a shape chosen
// here:
//
// - `offered` IS NOT RENAMED. It counts dispatch ATTEMPTS, not starts, and
//   lib/scheduler renamed it from `dispatched` precisely because a probe read
//   five "dispatched" while all five orders were already `failed`. `started` is
//   the half a reader wants. Relabelling either one at this layer would put the
//   lie back one level further from the code that knows better.
// - `lastError` AND `lastErrorAt` GO TOGETHER, always. lastError is never
//   cleared on its own, so without the timestamp a panel cannot tell "erroring
//   now" from "errored once at boot an hour ago" and the indicator stays red
//   forever. Rendering one without the other is the failure; shipping the pair
//   is what makes it avoidable.
// - NOTHING IS ADDED. The obvious candidate - how many orders are queued right
//   now - is exactly the O(store) read stats() is built to avoid, and the board
//   already has it from GET /api/orders. Adding a field here would also mean
//   editing lib/scheduler.js, which is a second file in a diff whose whole
//   point is that server.js does not grow.
//   ONE EXCEPTION since plan 3: `pausedProjectIds` ([{id, until, consecutive}])
//   beside the bare `pausedProjects` count. It is read from the scheduler's
//   own in-memory pause map - still O(paused projects), no store read - and a
//   board needs it to say WHICH project is paused rather than "one of them".
//
// Known limits:
// - `running` MEANS THE TIMER IS ARMED, NOT THAT THE LOOP IS MAKING PROGRESS.
//   It is `!!timer`. A tick that throws every time still leaves it true - the
//   interval survives a throw by design, so that a poll loop dying silently is
//   not indistinguishable from one with no work. `lastTickAt` and `errors` are
//   the fields that answer progress, and a panel that shows only `running` will
//   show green through a scheduler erroring on every tick.
// - `lastError` IS A RAW ERROR MESSAGE and can carry a filesystem path - an
//   ENOENT names the store file it could not open. That is not a new exposure
//   on this surface (GET /api/config already returns defaultDir, a path under
//   the user's home) and the server is loopback-only with a cross-origin guard
//   in front of every route, but it is the reason this endpoint is not a
//   candidate for ever being made public.
// - THERE IS NO WAY TO START OR STOP THE SCHEDULER THROUGH HTTP, on purpose.
//   Its lifetime is the process's: start() after the boot reconciles, stop()
//   before the shutdown reap. A POST that stopped it would leave a console
//   whose orders silently never run, with nothing in any record to say why.
module.exports = (deps) => {
  requireDeps('routes/scheduler', deps, REQUIRED);
  const { sendJson } = deps;

  return async ({ req, res, p }) => {
    // GET ONLY, and the method test is not decoration. In plan 2b a dispatch
    // route was written without one and answered ANY method, so a GET could
    // spawn a credentialed agent; it survived the first mutation sweep. Nothing
    // here spawns anything, but a handler that answers every verb is the shape
    // that was wrong then, and the next route copied from this one inherits
    // whichever shape it finds. Anything else falls through to the server's 404.
    if (p === '/api/scheduler' && req.method === 'GET') {
      // Enveloped like every sibling - { projects }, { goals }, { order } - so
      // a client destructures the same way whatever it asked for.
      sendJson(res, 200, { scheduler: scheduler.stats() });
      return true;
    }

    return false;
  };
};
