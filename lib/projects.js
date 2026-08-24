'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const store = require('./store');

// Known limits, deliberately not addressed here:
//
// - Cross-process races. create() is read-modify-write over one file with no
//   lock. It is fully synchronous, so two calls in ONE process cannot
//   interleave, but two processes (a second server, or a CLI run while the
//   server is up) can, and the loser's project is silently lost. Fixing it
//   needs lockfiles, which belongs with the scheduler.
// - Corruption discards earlier projects. If projects.json is unparseable the
//   store preserves the bytes as a .corrupt file and warns, but list() returns
//   [] and the next create() writes a fresh array, so the live file loses
//   everything that came before. Recovering automatically needs versioning.
// - Overlapping working trees. A symlink and its target now resolve to the
//   same stored path, so the overlap check can compare strings - but
//   duplicate records over one tree are still created and still undetected,
//   as is a repo root registered alongside a subdirectory of it. Belongs
//   with the scheduler.
// - branch is type-checked here, not validated. This layer only guarantees a
//   string or null. Git-ref legality, and rejecting a leading "-" (the
//   argument-injection shape), belong at the `git worktree add` call site,
//   because only that site knows the argv it builds.
// - A vanished project path is indistinguishable from a plain directory.
//   detectKind returns "dir" either way, so get() reports a deleted tree as a
//   dir project at concurrency 1 - safe in the concurrency direction, but it
//   is not evidence the directory is there. Anything about to spawn with that
//   path as its cwd must check the path itself.
// - list() returns kind as stored, not as re-detected. Only get() refreshes
//   it, because list() runs on every UI request and detectKind spawns git.
//   A rail row can therefore show GIT for a tree that is no longer one; the
//   value that gates concurrency is the one get() returns.

const FILE = 'projects.json';

const MAX_CONCURRENCY = 8;
const MAX_NAME = 200;

const DEFAULT_BUDGET = {
  maxOrdersPerGoal: 12,
  orderTimeoutMs: 900000, // 15 minutes
  maxOrdersPerDay: 100,
};

// Ceilings, not just floors: an orderTimeoutMs of 1e15 disables the stuck-agent
// guard exactly as effectively as 0 does, and 0 is the case this was written to
// catch. A bound only below is not "bounded".
const BUDGET_MAX = {
  maxOrdersPerGoal: 500,
  orderTimeoutMs: 24 * 60 * 60 * 1000, // 24h — longer than any single order should live
  maxOrdersPerDay: 10000,
};

// Kind is DETECTED, never taken from the caller: it decides whether agents can
// be isolated in worktrees, so a wrong value would let two agents corrupt one
// working tree.
//
// A stray .git file passes existsSync and would earn concurrency 2, then fail
// at `git worktree add` with "invalid gitfile format". Confirm git actually
// agrees this is a repository ROOT: --show-toplevel succeeds in a SUBDIRECTORY
// too, and a subdir cannot be isolated (worktree add there checks out the whole
// repo), so equality with the directory itself is the part that matters.
function detectKind(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return 'dir';
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      // create() is synchronous inside an HTTP handler, so a stalled git - a
      // repo on a dead network mount, say - blocks the whole event loop. On
      // timeout execFileSync throws and the catch below fails safely to dir.
      timeout: 5000,
      // rev-parse honours these, so a server launched from inside a git hook
      // or `git rebase --exec` would carry an ambient work-tree override and
      // could classify a non-repository as git. undefined values are dropped
      // by execFileSync rather than passed as the string "undefined".
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
    }).trim();
    return fs.realpathSync(top) === fs.realpathSync(dir) ? 'git' : 'dir';
  } catch (_) {
    // Not a usable repository - classify as dir and serialise. Being wrong in
    // this direction costs throughput; being wrong the other way costs the
    // user's working tree.
    return 'dir';
  }
}

// randomUUID, not a timestamp+random: remove() filters by predicate, so two
// records sharing an id would both be deleted by a single remove call.
function newId() {
  return 'prj-' + crypto.randomUUID();
}

// The same discipline safeBudget applies to unknown keys, applied to known
// keys with impossible types. These reach disk from an HTTP body and are read
// back without revalidation, so a wrong type here fails much later - in the
// scheduler, against a record that then needs hand-editing to recover.
function safeString(value, fallback, max) {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  if (!s) return fallback;
  return s.length > max ? s.slice(0, max) : s;
}

function safeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.length > 0 && v.length <= 500);
}

// Clamped and coerced: this arrives from an HTTP request body, and whatever
// schedules against it needs a positive integer, not "-5" or {}.
//
// Deliberately NOT merged with safeBudget: this has a kind-dependent hard
// override with no analogue there, and collapsing them would hide it.
function safeConcurrency(value, kind) {
  if (kind !== 'git') return 1; // no isolation mechanism; never raisable
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.min(n, MAX_CONCURRENCY);
}

// Allowlisted and bounded: unknown keys from an HTTP body must not become
// permanent state, and a zero or negative timeout would disable the only
// control standing between a stuck agent and an unbounded run.
function safeBudget(input) {
  const b = { ...DEFAULT_BUDGET };
  if (!input || typeof input !== 'object') return b;
  for (const key of Object.keys(DEFAULT_BUDGET)) {
    const n = Math.floor(Number(input[key]));
    if (Number.isFinite(n) && n > 0) b[key] = Math.min(n, BUDGET_MAX[key]);
  }
  return b;
}

function list(root) {
  return store.readJson(root, FILE, []);
}

function create(root, input) {
  const src = input && typeof input === 'object' ? input : {};
  // A truthy non-string path reaches path.resolve and throws a raw
  // ERR_INVALID_ARG_TYPE, which a route cannot distinguish from a server
  // fault. create() emits its own two shapes and nothing else.
  if (src.path !== undefined && src.path !== null && typeof src.path !== 'string') {
    throw new Error('path does not exist: ' + String(src.path));
  }
  // Resolve to absolute at creation. A relative path stored here would be
  // re-resolved against whatever cwd the process happens to have later, so a
  // record created as "." inside a repo (kind: git, concurrency 2) would point
  // at a plain directory after a restart from elsewhere - two agents over a
  // tree that cannot be isolated, which is the exact corruption `kind` exists
  // to prevent. The record outlives the process; the cwd does not.
  const dir = src.path ? path.resolve(src.path) : src.path;
  if (!dir || !fs.existsSync(dir)) throw new Error('path does not exist: ' + dir);
  // realpath, not just resolve: a symlink and its target would otherwise
  // register as two distinct records over one working tree, and the deferred
  // overlap check could not catch that with a string comparison. It must come
  // after the existence check, because realpath needs an existing path.
  let stat, real;
  try {
    stat = fs.statSync(dir);
    // realpath is inside the same try: it hits the filesystem too, so a
    // directory removed mid-call throws here just as readily as statSync does,
    // and the comment above promises create() emits only its own two shapes.
    real = fs.realpathSync(dir);
  } catch (_) {
    // Vanished mid-create. Report it as the caller's path problem, not as a
    // raw ENOENT.
    throw new Error('path does not exist: ' + dir);
  }
  if (!stat.isDirectory()) throw new Error('path is not a directory: ' + dir);

  const kind = detectKind(real);
  // A plain directory has no isolation mechanism, so it is serialised rather
  // than allowed to run agents concurrently over one working tree.
  const concurrency = safeConcurrency(src.concurrency, kind);

  // safeString guards the VALUE against being empty, not the fallback — and
  // path.basename('/') is ''. Registering the filesystem root therefore put
  // name: "" on disk, which every UI site then had to paper over by
  // convention. The path is never empty here, so it is the honest last resort.
  const fallbackName = path.basename(real) || real;

  const project = {
    id: newId(),
    name: safeString(src.name, fallbackName, MAX_NAME),
    kind,
    path: real,
    branch: safeString(src.branch, null, MAX_NAME),
    skillSources: safeStringArray(src.skillSources),
    agents: safeStringArray(src.agents),
    concurrency,
    budget: safeBudget(src.budget),
    createdAt: new Date().toISOString(),
  };

  const all = list(root);
  all.push(project);
  store.writeJson(root, FILE, all);
  return project;
}

// Re-detects kind rather than trusting the stored value. kind is decided once
// at create() and then lives on disk indefinitely, but the tree underneath it
// can stop being a repository — deleted and re-cloned in place, absorbed as a
// subdirectory of a parent repo, `git worktree remove`. A record still saying
// "git" then still carries concurrency 2, which is several agents over a tree
// with no isolation mechanism: the exact corruption kind exists to prevent.
//
// Only get() pays for this, not list(). list() is the UI path and runs on
// every request, and detectKind spawns git (~7ms) for anything carrying a
// .git; get() is a single record read before acting on it, which is where a
// scheduler asks and where the answer has to be true rather than remembered.
//
// Deliberately not written back. A read that silently mutates the store is
// surprising, and the stored value is the user's registration, not a cache.
// Note that a path which has vanished entirely detects as "dir" — safe in the
// concurrency direction, but a caller about to spawn into that cwd must check
// the path itself; this layer does not.
function get(root, id) {
  const p = list(root).find((r) => r.id === id) || null;
  if (!p) return null;
  const kind = detectKind(p.path);
  if (kind === p.kind) return p;
  return { ...p, kind, concurrency: safeConcurrency(undefined, kind) };
}

// Removes the RECORD only. The user's working directory is never touched —
// deleting a project must never delete their code. Returns whether a record
// actually matched, so an unknown id can 404 rather than reporting success.
function remove(root, id) {
  const all = list(root);
  const kept = all.filter((p) => p.id !== id);
  if (kept.length === all.length) return false; // nothing matched; let the route 404
  store.writeJson(root, FILE, kept);
  return true;
}

module.exports = {
  detectKind, newId, create, list, get, remove,
  DEFAULT_BUDGET, BUDGET_MAX, MAX_CONCURRENCY, MAX_NAME,
};
