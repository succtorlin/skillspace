'use strict';

// Destructuring a missing key binds `undefined` without complaint, so a factory
// that forgot to wire one constructs happily and fails later - at the first
// request that happens to need it, in a handler, as a bare TypeError with no
// hint that the cause was the wiring three hundred lines away in server.js.
//
// Both route factories promised in a comment that a missing key was "a
// boot-time fault rather than a TypeError on the first request". It was not.
// This is what makes that sentence true.
//
// Presence, not type. `root` is a string, `AGENTS` an array, `maxConcurrentRuns`
// a number and the rest functions; a type table here would be a second thing to
// keep in step with the server, and a key that is present but of the wrong type
// is a different bug with a different fix. `undefined` specifically, not
// falsy - `maxConcurrentRuns: 0` is a strange configuration but an intended
// one, and null is a caller saying something rather than forgetting to.
//
// All missing keys at once, not the first: a boot failure that names one key
// per run costs one restart per key.
function requireDeps(who, deps, required) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError(`${who}: a dependencies object is required`);
  }
  const missing = required.filter((k) => deps[k] === undefined);
  if (missing.length) {
    throw new TypeError(
      `${who}: missing dependenc${missing.length > 1 ? 'ies' : 'y'}: ${missing.join(', ')}`
    );
  }
  return deps;
}

module.exports = requireDeps;
