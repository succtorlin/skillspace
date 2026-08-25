'use strict';
const crypto = require('crypto');
const store = require('./store');

// A work order is the unit an agent executes and the unit the board watches.
// This module owns the record and its lifecycle only: it knows nothing about
// git, nothing about spawning, and never touches a filesystem outside `root`.
//
// Known limits:
// - goalId, acceptance, verdict and supersedes are stored but never read here.
//   They belong to the PM flow in plan 2b; the fields exist now so the record
//   shape does not change under an already-persisted store.
// - Same cross-process race as lib/projects: each order is its own file, so
//   two writers collide only on the same order, not on the whole collection.
//   That is strictly better than projects.json but still unlocked.

const SUB = 'orders';
const MAX_TEXT = 100000; // a prompt carrying an injected Skill body is large

// Terminal states. A settled order is never rewritten: a late close event from
// a process we already timed out would otherwise erase why it really ended.
const SETTLED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

// A bare randomUUID carries no creation order, and Date.now() collides: two
// orders created back to back land in the same millisecond ~78% of the time,
// leaving "newest first" to fall through to the random UUID and come out
// backwards on a third of pairs. Prefix the id with the timestamp plus a
// per-process tick so creation order is recorded in the id itself and the
// lexicographic contract store.list() already promises becomes meaningful.
// Zero-padded so string comparison matches numeric order.
//
// The tick resets on restart, so two orders created in the same millisecond by
// two different processes can still tie - unreachable for a localhost tool
// that creates orders from a human clicking, and strictly better than random.
let lastMs = 0;
let tick = 0;

function newId() {
  const now = Date.now();
  if (now === lastMs) tick++;
  else { lastMs = now; tick = 0; }
  return 'ord-' + String(now).padStart(14, '0') + String(tick).padStart(4, '0')
    + '-' + crypto.randomUUID();
}

function rel(id) {
  return `${SUB}/${id}.json`;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim().slice(0, MAX_TEXT);
}

function create(root, input) {
  const src = input && typeof input === 'object' ? input : {};
  const projectId = text(src.projectId, 'projectId');
  const prompt = text(src.prompt, 'prompt');

  const order = {
    id: newId(),
    projectId,
    goalId: null,          // plan 2b
    seq: null,             // plan 2b
    title: typeof src.title === 'string' ? src.title.trim().slice(0, 200) : '',
    prompt,
    acceptance: typeof src.acceptance === 'string' ? src.acceptance.slice(0, MAX_TEXT) : '',
    agent: null,
    cwd: null,
    status: 'queued',
    exitCode: null,
    verdict: null,         // plan 2b
    error: null,
    supersedes: null,      // plan 2b
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
  store.writeJson(root, rel(order.id), order);
  return order;
}

function get(root, id) {
  return store.readJson(root, rel(id), null);
}

function list(root, filter) {
  const f = filter || {};
  const all = store
    .list(root, SUB)
    .map((id) => get(root, id))
    .filter(Boolean);
  const picked = f.projectId ? all.filter((o) => o.projectId === f.projectId) : all;
  // Newest first: the board reads top-down and the newest order is the one a
  // human just created. createdAt is only millisecond-resolution and orders
  // routinely share one, so the id breaks the tie - it embeds the monotonic
  // tick from newId(), which is the only record of order within a millisecond.
  // Without that fallback the tie falls through to store.list()'s
  // lexicographic-by-UUID order, which is arbitrary.
  return picked.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
  );
}

// Every transition goes through here so the settled-state rule cannot be
// forgotten at one call site.
function patch(root, id, changes) {
  const o = get(root, id);
  if (!o) return null;
  if (SETTLED.has(o.status)) return o;
  const next = { ...o, ...changes };
  store.writeJson(root, rel(id), next);
  return next;
}

function markRunning(root, id, { cwd, agent }) {
  return patch(root, id, {
    status: 'running',
    cwd: cwd || null,
    agent: agent || null,
    startedAt: new Date().toISOString(),
  });
}

// exitCode 0 is the ONLY success. Note this records that the process exited
// zero, not that it did the right thing - that judgement is the PM verdict in
// plan 2b, and collapsing the two is the most common multi-agent failure.
function markFinished(root, id, { exitCode = null, error = null }) {
  const timedOutOrKilled = error !== null;
  return patch(root, id, {
    status: !timedOutOrKilled && exitCode === 0 ? 'succeeded' : 'failed',
    exitCode: timedOutOrKilled ? null : exitCode,
    error,
    finishedAt: new Date().toISOString(),
  });
}

// A failure before anything started - a worktree that could not be created,
// an agent binary that is not installed. startedAt stays null so the board can
// tell "never ran" from "ran and failed".
function markFailed(root, id, error) {
  return patch(root, id, {
    status: 'failed',
    error: String(error),
    finishedAt: new Date().toISOString(),
  });
}

function markCancelled(root, id) {
  return patch(root, id, {
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
  });
}

// Counted from persisted records rather than an in-memory tally, so the limit
// survives a restart.
function countToday(root, projectId) {
  const today = new Date().toISOString().slice(0, 10);
  return list(root, { projectId }).filter((o) => o.createdAt.slice(0, 10) === today).length;
}

// On boot, any order still marked running lost its child process when the
// previous server died. It is never assumed to have succeeded.
function reconcile(root) {
  let n = 0;
  for (const o of list(root)) {
    if (o.status !== 'running') continue;
    store.writeJson(root, rel(o.id), {
      ...o,
      status: 'interrupted',
      error: 'interrupted',
      finishedAt: new Date().toISOString(),
    });
    n++;
  }
  return n;
}

module.exports = {
  create, get, list, markRunning, markFinished, markFailed, markCancelled,
  countToday, reconcile, newId, SETTLED,
};
